import type * as FS from "node:fs/promises";
import {
  mkdtemp,
  mkdir,
  lstat,
  readlink,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repositoryProbePath } from "../../../src/node-common/repository-probe-path";
const recorded = vi.hoisted(() => ({ created: "" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FS>();
  return {
    ...fs,
    realpath: vi.fn(fs.realpath),
    stat: vi.fn(fs.stat),
    lstat: vi.fn(fs.lstat),
    symlink: vi.fn(fs.symlink),
    mkdtemp: vi.fn(async (prefix: Parameters<typeof fs.mkdtemp>[0]) => {
      const path = await fs.mkdtemp(prefix);
      recorded.created = path;
      return path;
    }),
  };
});
let root: string;
const scopes: Awaited<ReturnType<typeof repositoryProbePath>>[] = [];
beforeEach(async () => {
  const actual = await vi.importActual<typeof FS>("node:fs/promises");
  vi.mocked(realpath).mockImplementation(actual.realpath);
  vi.mocked(stat).mockImplementation(actual.stat);
  vi.mocked(lstat).mockImplementation(actual.lstat);
  vi.mocked(symlink).mockImplementation(actual.symlink);
  root = await realpath(await mkdtemp(join(tmpdir(), "probe-path-test-")));
  recorded.created = "";
});
afterEach(async () => {
  await Promise.all(scopes.splice(0).map((scope) => scope.dispose()));
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const create = async (path: string, excluded: readonly string[] = []) => {
  const scope = await repositoryProbePath({ PATH: path }, excluded);
  scopes.push(scope);
  return scope;
};
describe.skipIf(process.platform === "win32")("private probe PATH", () => {
  it("pins verified canonical tools, excludes user bins, shadows missing interpreters and disposes", async () => {
    const bins = join(root, "bin");
    const safe = join(root, "safe");
    const repo = join(root, "repo");
    await Promise.all([mkdir(bins), mkdir(safe), mkdir(repo)]);
    await writeFile(join(safe, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await symlink(join(safe, "node"), join(bins, "node"));
    await mkdir(join(bins, "pnpm")); // A searchable directory is not an executable tool.
    const scope = await create(["relative", bins].join(delimiter), [repo]);
    const pinned = scope.path.split(delimiter)[0];
    if (!pinned) throw new Error("No pin directory");
    const info = await lstat(pinned);
    expect(info.mode & 0o777).toBe(0o700);
    expect(info.uid).toBe(process.getuid?.());
    expect(scope.resolve("node")).toBe(join(safe, "node"));
    expect(await readlink(join(pinned, "node"))).toBe(join(safe, "node"));
    expect(scope.resolve("pnpm")).toBeUndefined();
    expect(await readFile(join(pinned, "pnpm"), "utf8")).toContain("exit 127");
    expect(scope.path.split(delimiter)).not.toContain(bins);
    for (const path of scope.path.split(delimiter).slice(1)) {
      const system = await stat(path);
      expect(system.uid).toBe(0);
      expect(system.mode & 0o022).toBe(0);
    }
    await scope.dispose();
    expect(scope.resolve("node")).toBeUndefined();
    expect(scope.assertOpen).toThrow("closed");
    await expect(lstat(pinned)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cannot fall through to a system node when the verified interpreter is absent", async () => {
    const scope = await create("");
    const pinned = scope.path.split(delimiter)[0];
    if (!pinned) throw new Error("No pins");
    await expect(
      promisify(execFile)(join(pinned, "node"), ["--version"], { env: { PATH: scope.path } }),
    ).rejects.toMatchObject({ code: 127 });
  });
  it("omits a login tool already resolving inside the repository", async () => {
    const repo = join(root, "repo"),
      bins = join(root, "bin");
    await Promise.all([mkdir(repo), mkdir(bins)]);
    await writeFile(join(repo, "node"), "fixture", { mode: 0o700 });
    await symlink(join(repo, "node"), join(bins, "node"));
    expect((await create(bins, [repo])).resolve("node")).toBeUndefined();
  });
  it.each(["writable", "owner", "file", "symlink"])(
    "refuses unsafe private directory metadata: %s",
    async (kind) => {
      const actual = await vi.importActual<typeof FS>("node:fs/promises");
      vi.mocked(lstat).mockImplementationOnce(async (path) => {
        const info = await actual.lstat(path);
        if (kind === "writable") info.mode |= 0o022;
        if (kind === "owner") info.uid += 1;
        if (kind === "file") Object.defineProperty(info, "isDirectory", { value: () => false });
        if (kind === "symlink")
          Object.defineProperty(info, "isSymbolicLink", { value: () => true });
        return info;
      });
      await expect(create("")).rejects.toThrow("Unsafe probe directory");
      await expect(actual.lstat(recorded.created)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("cleans partial pin construction on failure", async () => {
    const bins = join(root, "bin");
    await mkdir(bins);
    await writeFile(join(bins, "node"), "fixture", { mode: 0o700 });
    vi.mocked(symlink).mockRejectedValueOnce(new Error("No link"));
    await expect(create(bins)).rejects.toThrow("No link");
    await expect(lstat(recorded.created)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["writable", "owner", "file", "excluded"])(
    "refuses an unsafe fixed interpreter/system scope: %s",
    async (kind) => {
      const actual = await vi.importActual<typeof FS>("node:fs/promises");
      vi.mocked(stat).mockImplementation(async (path) => {
        const info = await actual.stat(path);
        if (kind === "writable") info.mode |= 0o022;
        if (kind === "owner") info.uid += 1;
        if (kind === "file") {
          Object.defineProperty(info, "isDirectory", { value: () => false });
          Object.defineProperty(info, "isFile", { value: () => false });
        }
        return info;
      });
      const excluded = kind === "excluded" ? [await actual.realpath("/bin/sh")] : [];
      await expect(create("", excluded)).rejects.toThrow("Unsafe probe interpreter");
      expect(recorded.created).toBe("");
    },
  );
  it("omits system directories inside the excluded code root", async () => {
    const excluded = await realpath("/usr/sbin");
    expect((await create("", [excluded])).path.split(delimiter)).not.toContain(excluded);
  });
  it("pins a Homebrew executable only through its permitted installation directory", async () => {
    const file = join(root, "brew");
    await writeFile(file, "fixture", { mode: 0o700 });
    const actual = await vi.importActual<typeof FS>("node:fs/promises");
    vi.mocked(realpath).mockImplementation((path, options) => {
      if (typeof path === "string" && path.startsWith("/usr/local/bin/"))
        return path.endsWith("/brew")
          ? Promise.resolve(file)
          : Promise.reject(new Error("No fixture tool"));
      return actual.realpath(path, options);
    });
    expect((await create("/usr/local/bin")).resolve("brew")).toBe(file);
  });
  it("rejects a pin directory placed inside an excluded tree", async () => {
    await expect(create("", [await realpath(tmpdir())])).rejects.toThrow("Unsafe probe directory");
    await expect(lstat(recorded.created)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cleans a directory when canonicalization fails after creation", async () => {
    const actual = await vi.importActual<typeof FS>("node:fs/promises");
    vi.mocked(realpath).mockImplementation((path, options) =>
      typeof path === "string" && path.includes("foom-setup-probes-")
        ? Promise.reject(new Error("Lost directory"))
        : actual.realpath(path, options),
    );
    await expect(create("")).rejects.toThrow("Lost directory");
    await expect(lstat(recorded.created)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
