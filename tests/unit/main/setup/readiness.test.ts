import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { checkReadiness } from "../../../../src/main/setup/readiness";
import { loginPath } from "../../../../src/main/agents/agents";
import { resolveForgeExecutable } from "../../../../src/main/control/forge-process";

vi.mock("../../../../src/main/agents/agents", () => ({ loginPath: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(version = "git version 2.45.0", fail = false) {
  const root = await mkdtemp(join(tmpdir(), "foom-readiness-"));
  roots.push(root);
  await mkdir(join(root, "repo"));
  const git = join(root, "git");
  await writeFile(
    git,
    `#!${process.execPath}\nconst args=process.argv.slice(2); if(args[0]==='--version') {console.log(${JSON.stringify(version)});process.exit(${fail ? "1" : "0"});} if(process.cwd().endsWith('repo')) console.log('remote.origin.url git@github.com:o/r.git\\nremote.backup.url https://gitlab.com/g/r.git\\nremote.dup.url https://github.com/o/other\\nremote.unknown.url https://unknown.example/o/r\\nremote.bad.url https://user:secret@bad.example/o/r'); else process.exit(1);`,
    { mode: 0o755 },
  );
  vi.mocked(loginPath).mockResolvedValue({ path: root, warning: null });
  return { root, repo: join(root, "repo"), git };
}
test("resolves only login PATH, reads fixture version and probes only deduplicated repository hosts", async () => {
  const f = await fixture();
  const forge = vi.fn(() => Promise.resolve("ready" as const));
  const report = await checkReadiness([f.repo, f.root], forge);
  expect(report.git).toBe("ready");
  expect(report.forges.map((row) => row.host)).toEqual([
    "github.com",
    "gitlab.com",
    "unknown.example",
  ]);
  expect(forge.mock.calls).toHaveLength(3);
  expect(await checkReadiness([], forge)).toMatchObject({ git: "ready", forges: [] });
});
test("missing, malformed and failing git remain fixed no-go statuses without CLI output", async () => {
  const f = await fixture("private malformed diagnostic");
  const forge = vi.fn(() => Promise.resolve("ready" as const));
  expect(await checkReadiness([f.repo], forge)).toMatchObject({
    git: "invalid-version",
    forges: [],
  });
  await rm(f.git);
  expect(await checkReadiness([f.repo], forge)).toMatchObject({ git: "not-installed", forges: [] });
  await fixture("secret failure", true);
  expect(await checkReadiness([f.repo], forge)).toMatchObject({ git: "unavailable", forges: [] });
  expect(forge).not.toHaveBeenCalled();
});
test.each(["darwin", "win32", "linux"])(
  "narrows the platform %s without starting git",
  async (platform) => {
    const f = await fixture();
    await rm(f.git);
    vi.spyOn(process, "platform", "get").mockReturnValue(platform as NodeJS.Platform);
    // Native resolver may use Windows suffixes; no executable remains in either case.
    expect((await checkReadiness([], () => Promise.resolve("ready"))).platform).toBe(
      platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux",
    );
    expect(await resolveForgeExecutable(["git"], f.root).catch(() => undefined)).toBeUndefined();
  },
);

test("a forge failure stays soft and never conceals a healthy git result", async () => {
  const f = await fixture();
  const result = await checkReadiness([f.repo], () =>
    Promise.reject(new Error("private diagnostic")),
  );
  expect(result.git).toBe("ready");
  expect(result.forges).toHaveLength(3);
  expect(result.forges.every((row) => row.status === "unavailable")).toBe(true);
});
