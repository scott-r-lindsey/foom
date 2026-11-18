import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { removeRetiredRepositorySetup } from "../../../../src/main/wiring/profile-migrations";

vi.mock("../../../../src/node-common/private-file-permissions", () => ({ windowsAcl: vi.fn() }));

let profile: string;
beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), "foom-setup-retirement-"));
});
afterEach(async () => {
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

test("refuses to remove a state file reached through a redirected store directory", async () => {
  const target = join(profile, "other");
  await mkdir(target, { mode: 0o700 });
  const state = join(target, "state.json");
  await writeFile(state, "keep", { mode: 0o600 });
  await symlink(target, join(profile, "repository-setup"), "junction");

  await expect(removeRetiredRepositorySetup(profile)).rejects.toThrow("Unable to retire");
  await expect(readFile(state, "utf8")).resolves.toBe("keep");
});
