import { mkdir, mkdtemp, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as worktreeOperations from "../../../../src/main/workspace/worktree-operations";
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
  await mkdir(cwd);
  await git(["init", "-q"], { cwd });
  return cwd;
}

afterEach(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { force: true, recursive: true });
});

test("dispatcher repository admission accepts direct Git roots only", async () => {
  const { source, external } = await fixture();
  const path = await repository(source, "project A");
  await repository(source, ".hidden");
  await mkdir(join(source, "empty"));
  const outer = await repository(external, "outside");
  const nested = await repository(path, "nested");
  await expect(sourceRepository(source, "project A")).resolves.toMatchObject({
    name: "project A",
    path,
  });
  await expect(sourceRepository(source, "empty")).rejects.toThrow("not_found");
  for (const attempt of [
    outer,
    nested,
    "..",
    "../external",
    "project A/nested",
    ".hidden",
    "C:\\external",
  ]) {
    await expect(sourceRepository(source, attempt)).rejects.toThrow("invalid_request");
  }
  await expect(sourceRepositories(source)).resolves.toEqual([
    expect.objectContaining({ name: "project A", path }),
  ]);
});

test("dispatcher repository admission refuses directories and Git markers redirected by links", async () => {
  const { source, external } = await fixture();
  const outer = await repository(external, "outside");
  await symlink(outer, join(source, "escape"), "junction");
  await expect(sourceRepository(source, "escape")).rejects.toThrow("not_found");
  await expect(sourceDirectoryIdentity(join(source, "escape"))).rejects.toThrow("not_found");
  const fake = join(source, "false-repository");
  await mkdir(fake);
  await symlink(join(outer, ".git"), join(fake, ".git"), "junction");
  await expect(sourceRepository(source, "false-repository")).rejects.toThrow("not_found");
});

test("repository inventory fails closed for unverified Git roots and changed checkouts", async () => {
  const { source, external } = await fixture();
  const invalid = join(source, "broken");
  await mkdir(join(invalid, ".git"), { recursive: true });
  await expect(sourceRepository(source, "broken")).rejects.toThrow("not_found");
  await expect(sourceDirectoryIdentity(join(source, "gone"))).rejects.toThrow("not_found");
  const path = await repository(source, "race");
  const readIdentity = worktreeOperations.worktreeIdentity;
  const identity = vi.spyOn(worktreeOperations, "worktreeIdentity");
  identity.mockRejectedValueOnce(new Error("Checkout became unavailable"));
  await expect(sourceRepositories(source)).rejects.toThrow("conflict");
  identity.mockImplementationOnce(async (checkout) => {
    const before = await readIdentity(checkout);
    await rename(join(checkout, ".git"), join(external, "marker"));
    return before;
  });
  await expect(sourceRepository(source, "race")).rejects.toThrow("conflict");
  expect(identity).toHaveBeenCalledWith(path);
});
