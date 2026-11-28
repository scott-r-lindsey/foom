import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as worktreeOperations from "../../../../src/main/workspace/worktree-operations";
import { WorktreeService } from "../../../../src/main/workspace/worktrees";
import { git } from "../../../helpers/git.js";
import {
  sourceRepositories,
  sourceDirectoryIdentity,
  sourceRepository,
} from "../../../../src/main/workspace/source-repositories";

let fixtureRoot: string | undefined;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foom-dispatcher-")));
  fixtureRoot = root;
  const source = join(root, "source");
  const external = join(root, "external");
  await mkdir(source);
  await mkdir(external);
  return { source, external };
}

async function repository(folder: string, name: string) {
  const cwd = join(folder, name);
  await mkdir(cwd, { recursive: true });
  await git(["init", "-q"], { cwd });
  return cwd;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (fixtureRoot) await rm(fixtureRoot, { force: true, recursive: true });
});

test("dispatcher inventory includes exactly the verified local registrations", async () => {
  const { source, external } = await fixture();
  const path = await repository(join(source, "team"), "project");
  const deleted = join(source, "deleted");
  const outer = await repository(external, "project");
  const unregistered = await repository(source, "unregistered");
  const entries = [
    { name: "project", path },
    { name: "project", path: outer },
    { name: "deleted", path: deleted },
  ];
  const registry = () => entries;
  await expect(sourceRepository(registry, source, path)).resolves.toMatchObject({
    name: join("team", "project"),
    path,
  });
  for (const attempt of [unregistered, join(path, ".git"), `${path}/../project`]) {
    await expect(sourceRepository(registry, source, attempt)).rejects.toThrow("not_found");
  }
  for (const attempt of [
    "project",
    "..",
    "../external",
    "team/project",
    null,
    "/a\0b",
    "/" + "a".repeat(4096),
  ]) {
    await expect(sourceRepository(registry, source, attempt)).rejects.toThrow("invalid_request");
  }
  await expect(sourceRepositories(registry, source)).resolves.toEqual([
    expect.objectContaining({ name: outer, path: outer }),
    expect.objectContaining({ name: join("team", "project"), path }),
  ]);
  const registered = { name: "project", path };
  expect(await sourceRepositories(() => [registered], path)).toEqual([
    expect.objectContaining({ name: ".", path }),
  ]);
});

test("dispatcher admission refuses redirected folders, Git markers and non-repositories", async () => {
  const { source, external } = await fixture();
  const outer = await repository(external, "outside");
  const escape = join(source, "escape");
  await symlink(outer, escape, "junction");
  const fake = join(source, "false-repository");
  await mkdir(fake);
  await symlink(join(outer, ".git"), join(fake, ".git"), "junction");
  const invalid = join(source, "broken");
  await mkdir(join(invalid, ".git"), { recursive: true });
  const entries = [
    { name: "link", path: escape },
    { name: "fake", path: fake },
    { name: "broken", path: invalid },
  ];
  await expect(sourceDirectoryIdentity(escape)).rejects.toThrow("not_found");
  await expect(sourceDirectoryIdentity(join(source, "gone"))).rejects.toThrow("not_found");
  await expect(sourceRepositories(() => entries, source)).resolves.toEqual([]);
});

test("dispatcher admits registered linked worktrees and separate Git directories", async () => {
  const { source, external } = await fixture();
  const main = await repository(external, "main");
  await git(
    [
      "-c",
      "user.name=Foom",
      "-c",
      "user.email=foom@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "init",
    ],
    { cwd: main },
  );
  const linked = join(source, "linked");
  await git(["worktree", "add", "--detach", linked], { cwd: main });
  const separate = join(source, "sepa\u200drate");
  const metadata = join(external, "metadata");
  await mkdir(separate);
  await mkdir(metadata);
  await git(["init", "--separate-git-dir", join(metadata, ".git")], { cwd: separate });
  const worktrees = new WorktreeService();
  for (const path of [linked, separate]) await worktrees.addRepository(path);
  const registry = () => worktrees.listRepositories();
  await expect(sourceRepositories(registry, source)).resolves.toEqual([
    expect.objectContaining({ path: linked }),
    expect.objectContaining({ path: separate }),
  ]);
  await expect(sourceRepository(registry, source, linked)).resolves.toMatchObject({ path: linked });
  const proof = await sourceRepository(registry, source, separate);
  expect(proof.path).toBe(separate);
  await expect(worktrees.listWorktrees(separate)).resolves.toMatchObject([{ path: separate }]);
  await expect(worktrees.launchIdentity(separate, separate)).resolves.toBe(proof.identity);
  await expect(sourceRepository(registry, source, metadata)).rejects.toThrow("not_found");
});

test.skipIf(process.platform === "win32")(
  "dispatcher preserves the trailing space in a registered path",
  async () => {
    const { source } = await fixture();
    const path = await repository(source, "spaced ");
    const worktrees = new WorktreeService();
    await expect(worktrees.addRepository(path)).resolves.toMatchObject({ path });
    const registry = () => worktrees.listRepositories();
    await expect(sourceRepositories(registry, source)).resolves.toEqual([
      expect.objectContaining({ path }),
    ]);
    await expect(sourceRepository(registry, source, path)).resolves.toMatchObject({ path });
  },
);

test("a registered checkout loses dispatcher access when its Git marker is removed", async () => {
  const { source, external } = await fixture();
  const path = await repository(source, "project");
  const registration = { name: "project", path };
  const registry = () => [registration];
  await expect(sourceRepositories(registry, source)).resolves.toEqual([
    expect.objectContaining({ path }),
  ]);

  await rename(join(path, ".git"), join(external, "marker"));

  await expect(sourceRepository(registry, source, path)).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(sourceRepositories(registry, source)).resolves.toEqual([]);
});

test("a dispatcher page only verifies its cursor and enough available repositories", async () => {
  const { source } = await fixture();
  const first = await repository(source, "a-first");
  const missing = join(source, "b-missing");
  const second = await repository(source, "c-second");
  const third = await repository(source, "d-third");
  const later = await repository(source, "e-later");
  const entries = [later, third, second, missing, first].map((path) => ({ name: path, path }));
  const registry = () => entries;
  const inspect = vi.spyOn(worktreeOperations, "git");
  const page = { after: first, take: 2, signal: undefined };
  await expect(sourceRepositories(registry, source, page)).resolves.toMatchObject([
    { path: second },
    { path: third },
  ]);
  expect(inspect.mock.calls.map(([path]) => path)).toEqual([first, second, third]);
  for (const after of [missing, join(source, "unregistered")]) {
    await expect(sourceRepositories(registry, source, { ...page, after })).rejects.toThrow(
      "not_found",
    );
  }
});

test("dispatcher inventory stops verifying Git after the client disconnects", async () => {
  const { source } = await fixture();
  const first = await repository(source, "a-first");
  const second = await repository(source, "b-second");
  const entries = [first, second].map((path) => ({ name: path, path }));
  const registry = () => entries;
  const controller = new AbortController();
  const read = worktreeOperations.git;
  const inspect = vi.spyOn(worktreeOperations, "git").mockImplementationOnce(async (...args) => {
    const result = await read(...args);
    controller.abort();
    return result;
  });
  await expect(
    sourceRepositories(registry, source, { after: undefined, take: 2, signal: controller.signal }),
  ).rejects.toThrow("unavailable");
  expect(inspect).toHaveBeenCalledOnce();
});

test("dispatcher admission rechecks the checkout and registry after verifying Git", async () => {
  const { source, external } = await fixture();
  const path = await repository(source, "race");
  const entry = { name: "race", path };
  let rows = [entry];
  const registry = () => rows;
  const readIdentity = worktreeOperations.worktreeIdentity;
  const identity = vi.spyOn(worktreeOperations, "worktreeIdentity");
  identity.mockRejectedValueOnce(new Error("Checkout became unavailable"));
  await expect(sourceRepositories(registry, source)).rejects.toThrow("conflict");
  identity.mockImplementationOnce(async (checkout) => {
    const before = await readIdentity(checkout);
    rows = [];
    return before;
  });
  await expect(sourceRepository(registry, source, path)).rejects.toThrow("conflict");
  rows = [entry];
  identity.mockImplementationOnce(async (checkout) => {
    const before = await readIdentity(checkout);
    await rename(join(checkout, ".git"), join(external, "marker"));
    return before;
  });
  await expect(sourceRepository(registry, source, path)).rejects.toThrow("conflict");
  expect(identity).toHaveBeenCalledWith(path);
});
