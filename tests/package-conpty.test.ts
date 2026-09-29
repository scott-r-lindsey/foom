import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

const load = createRequire(import.meta.url);
// The Forge hook is CommonJS; test its actual exported contract without a cast.
const hook: unknown = load("../scripts/package-conpty.cjs");
async function packageConpty(root: string, platform: string, arch: string) {
  if (typeof hook !== "function") throw new Error("Missing packaging hook");
  const result: unknown = Reflect.apply(hook, undefined, [{}, root, "44.4.5", platform, arch]);
  await result;
}
let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
async function fixture() {
  root = await mkdtemp(join(tmpdir(), "foom-conpty-"));
  const pty = join(root, "node_modules", "node-pty");
  const release = join(pty, "build", "Release");
  await mkdir(release, { recursive: true });
  await writeFile(join(release, "conpty.node"), "rebuilt addon");
  for (const arch of ["x64", "arm64"]) {
    const source = join(pty, "prebuilds", `win32-${arch}`, "conpty");
    await mkdir(source, { recursive: true });
    for (const file of ["conpty.dll", "OpenConsole.exe"])
      await writeFile(join(source, file), `${arch}:${file}`);
  }
  return { root, pty, release };
}
test.each(["x64", "arm64"])(
  "restores the %s support files after a native rebuild",
  async (arch) => {
    const { root, release } = await fixture();
    await packageConpty(root, "win32", arch);
    for (const file of ["conpty.dll", "OpenConsole.exe"]) {
      expect(await readFile(join(release, "conpty", file), "utf8")).toBe(`${arch}:${file}`);
    }
    expect(await readFile(join(release, "conpty.node"), "utf8")).toBe("rebuilt addon");
  },
);
test("leaves other platforms and prebuild-only installations alone", async () => {
  const { root, release } = await fixture();
  await packageConpty(root, "linux", "x64");
  await expect(readFile(join(release, "conpty", "conpty.dll"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await rm(join(release, "conpty.node"));
  await packageConpty(root, "win32", "x64");
  await expect(readFile(join(release, "conpty", "conpty.dll"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
test("fails packaging if the matching support files are missing", async () => {
  const { root, pty } = await fixture();
  await rm(join(pty, "prebuilds", "win32-x64", "conpty", "OpenConsole.exe"));
  await expect(packageConpty(root, "win32", "x64")).rejects.toMatchObject({ code: "ENOENT" });
});
