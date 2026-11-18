import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { removeRetiredRepositorySetup } from "../../../../src/main/wiring/profile-migrations";

vi.mock("../../../../src/node-common/private-file-permissions", () => ({ windowsAcl: vi.fn() }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FsPromises>();
  return { ...fs, unlink: vi.fn(fs.unlink) };
});

let profile: string;
beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), "foom-setup-retirement-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(profile, { recursive: true, force: true });
});

test("drops legacy setup records on startup and allows subsequent starts", async () => {
  const directory = join(profile, "repository-setup");
  const state = join(directory, "state.json");
  const toolchain = join(directory, "toolchains", "marker");
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, "toolchains"));
  await writeFile(toolchain, "keep");
  await writeFile(join(profile, "worktrees.json"), '{"version":1}');
  await writeFile(
    state,
    JSON.stringify({
      version: 1,
      approvals: [
        { list: { requirements: [{ kind: "toolchain", tool: "node", version: "24.x" }] } },
      ],
      rows: [{ state: "needs-setup" }],
    }),
    { mode: 0o600 },
  );

  await removeRetiredRepositorySetup(profile);
  await expect(readFile(state)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(toolchain, "utf8")).resolves.toBe("keep");
  await expect(readFile(join(profile, "worktrees.json"), "utf8")).resolves.toBe('{"version":1}');
  await expect(removeRetiredRepositorySetup(profile)).resolves.toBeUndefined();
});

test("does not create a setup directory in a profile without legacy records", async () => {
  await removeRetiredRepositorySetup(profile);
  await expect(readFile(join(profile, "repository-setup", "state.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test.skipIf(process.platform === "win32")(
  "leaves a toolchain-only directory with nonprivate permissions in place",
  async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const directory = join(profile, "repository-setup");
    const toolchains = join(directory, "toolchains");
    await mkdir(toolchains, { recursive: true });
    await chmod(directory, 0o755);
    const marker = join(toolchains, "marker");
    await writeFile(marker, "keep");

    await expect(removeRetiredRepositorySetup(profile)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Cleanup will retry at startup"));
    await expect(readFile(marker, "utf8")).resolves.toBe("keep");
  },
);

test("a busy state file is preserved and retried on the next launch", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const directory = join(profile, "repository-setup");
  const state = join(directory, "state.json");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(state, '{"version":1,"approvals":[],"rows":[]}', { mode: 0o600 });
  vi.mocked(unlink).mockRejectedValueOnce(Object.assign(new Error("Busy"), { code: "EBUSY" }));

  await expect(removeRetiredRepositorySetup(profile)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Cleanup will retry at startup"));
  await expect(readFile(state, "utf8")).resolves.toContain('"version":1');

  await removeRetiredRepositorySetup(profile);
  await expect(readFile(state)).rejects.toMatchObject({ code: "ENOENT" });
  expect(warn).toHaveBeenCalledTimes(1);
});

test("leaves a state file reached through a redirected store directory in place", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const target = join(profile, "other");
  await mkdir(target, { mode: 0o700 });
  const state = join(target, "state.json");
  await writeFile(state, "keep", { mode: 0o600 });
  await symlink(target, join(profile, "repository-setup"), "junction");

  await expect(removeRetiredRepositorySetup(profile)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Cleanup will retry at startup"));
  await expect(readFile(state, "utf8")).resolves.toBe("keep");
});
