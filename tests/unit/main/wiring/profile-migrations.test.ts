import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { removeRetiredRepositorySetup } from "../../../../src/main/wiring/profile-migrations";

vi.mock("../../../../src/node-common/private-file-permissions", () => ({ windowsAcl: vi.fn() }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    realpath: vi.fn(fs.realpath),
    rename: vi.fn(fs.rename),
    unlink: vi.fn(fs.unlink),
  };
});

let profile: string;
let shutdown: AbortController;
beforeEach(async () => {
  shutdown = new AbortController();
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

  await removeRetiredRepositorySetup(profile, shutdown.signal);
  await expect(readFile(state)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(toolchain, "utf8")).resolves.toBe("keep");
  await expect(readFile(join(profile, "worktrees.json"), "utf8")).resolves.toBe('{"version":1}');
  await expect(removeRetiredRepositorySetup(profile, shutdown.signal)).resolves.toBeUndefined();
});

test("does not create a setup directory in a profile without legacy records", async () => {
  await removeRetiredRepositorySetup(profile, shutdown.signal);
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

    await expect(removeRetiredRepositorySetup(profile, shutdown.signal)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Cleanup will retry at startup"));
    await expect(readFile(marker, "utf8")).resolves.toBe("keep");
  },
);

test("a busy state file that cannot be renamed is retried on the next launch", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const directory = join(profile, "repository-setup");
  const state = join(directory, "state.json");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(state, '{"version":1,"approvals":[],"rows":[]}', { mode: 0o600 });
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("Busy"), { code: "EBUSY" }));

  await expect(removeRetiredRepositorySetup(profile, shutdown.signal)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Cleanup will retry at startup"));
  await expect(readFile(state, "utf8")).resolves.toContain('"version":1');

  await removeRetiredRepositorySetup(profile, shutdown.signal);
  await expect(readFile(state)).rejects.toMatchObject({ code: "ENOENT" });
  expect(warn).toHaveBeenCalledTimes(1);
});

test("a replacement at the original pathname survives a pending unlink", async () => {
  const fs = await vi.importActual<typeof FsPromises>("node:fs/promises");
  const directory = join(await realpath(profile), "repository-setup");
  const state = join(directory, "state.json");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(state, "retired", { mode: 0o600 });

  const held = Promise.withResolvers<undefined>();
  const pendingUnlink = vi.fn(async (file: Parameters<typeof unlink>[0]) => {
    await held.promise;
    await fs.unlink(file);
  });
  vi.mocked(unlink).mockImplementationOnce(pendingUnlink);
  const cleanup = removeRetiredRepositorySetup(profile, shutdown.signal);
  let target: string;
  try {
    await vi.waitFor(() => {
      expect(pendingUnlink).toHaveBeenCalledOnce();
    });
    const file = pendingUnlink.mock.lastCall?.[0];
    if (typeof file !== "string") throw new Error("Missing unlink pathname");
    target = file;
    expect(target).not.toBe(state);
    await expect(readFile(target, "utf8")).resolves.toBe("retired");
    await writeFile(state, "replacement", { flag: "wx", mode: 0o600 });
  } finally {
    held.resolve(undefined);
    await cleanup;
  }
  await expect(readFile(state, "utf8")).resolves.toBe("replacement");
  await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
});

test("preserves a replacement moved by the rename when its identity differs", async () => {
  const fs = await vi.importActual<typeof FsPromises>("node:fs/promises");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const directory = join(await realpath(profile), "repository-setup");
  const state = join(directory, "state.json");
  const saved = join(directory, "saved.json");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(state, "retired", { mode: 0o600 });
  const replaceDuringRename = vi.fn(async (...[from, to]: Parameters<typeof rename>) => {
    await fs.rename(from, saved);
    await writeFile(from, "replacement", { mode: 0o600 });
    await fs.rename(from, to);
    await writeFile(from, "current", { mode: 0o600 });
  });
  vi.mocked(rename).mockImplementationOnce(replaceDuringRename);

  await removeRetiredRepositorySetup(profile, shutdown.signal);

  const target = replaceDuringRename.mock.lastCall?.[1];
  if (!target) throw new Error("Missing rename destination");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Cleanup will retry at startup"));
  await expect(readFile(target, "utf8")).resolves.toBe("replacement");
  await expect(readFile(saved, "utf8")).resolves.toBe("retired");
  await expect(readFile(state, "utf8")).resolves.toBe("current");
});

test("leaves a state file reached through a redirected store directory in place", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const target = join(profile, "other");
  await mkdir(target, { mode: 0o700 });
  const state = join(target, "state.json");
  await writeFile(state, "keep", { mode: 0o600 });
  await symlink(target, join(profile, "repository-setup"), "junction");

  await expect(removeRetiredRepositorySetup(profile, shutdown.signal)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("Cleanup will retry at startup"));
  await expect(readFile(state, "utf8")).resolves.toBe("keep");
});

test("shutdown during verification leaves the retired state for the next launch", async () => {
  const canonicalProfile = await realpath(profile);
  const directory = join(canonicalProfile, "repository-setup");
  const state = join(directory, "state.json");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(state, '{"version":1,"approvals":[],"rows":[]}', { mode: 0o600 });

  const held = Promise.withResolvers<string>();
  vi.mocked(realpath).mockReturnValueOnce(held.promise);
  const cleanup = removeRetiredRepositorySetup(profile, shutdown.signal);
  shutdown.abort();
  held.resolve(canonicalProfile);
  await cleanup;

  await removeRetiredRepositorySetup(profile, shutdown.signal);
  await expect(readFile(state, "utf8")).resolves.toContain('"version":1');
});
