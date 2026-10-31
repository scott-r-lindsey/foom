import { afterEach, beforeEach, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readWorktreeProvenance,
  writeWorktreeProvenance,
  worktreeProvenancePath,
} from "../../../../src/terminal-host/remote/worktree-provenance";
let root: string;
let repository: string;
let path: string;
const profile = "a".repeat(32);
const origin = "git@fixture.test:team/repo.git";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "provenance-"));
  repository = join(root, "repo");
  path = join(root, ".foom-worktree-owned");
  await mkdir(repository, { mode: 0o700 });
  await mkdir(path, { mode: 0o700 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
test.skipIf(process.platform === "win32")(
  "durable provenance survives new readers but rejects replaced checkout and repository directories",
  async () => {
    expect(await readWorktreeProvenance(path)).toBeUndefined();
    await writeWorktreeProvenance(profile, repository, path, origin);
    expect(await readWorktreeProvenance(path)).toEqual({ profile, repository, origin });
    await expect(writeWorktreeProvenance(profile, repository, path, origin)).rejects.toThrow();
    for (const directory of [path, repository]) {
      await rename(directory, `${directory}-old`);
      await mkdir(directory, { mode: 0o700 });
      expect(await readWorktreeProvenance(path)).toBeUndefined();
      await rm(directory, { recursive: true });
      await rename(`${directory}-old`, directory);
      expect(await readWorktreeProvenance(path)).toEqual({ profile, repository, origin });
    }
  },
);
test.skipIf(process.platform === "win32")(
  "unsafe directories, unsafe markers and corrupt metadata never establish ownership",
  async () => {
    await writeWorktreeProvenance(profile, repository, path, origin);
    const marker = worktreeProvenancePath(path);
    const text = await readFile(marker, "utf8");
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") throw new Error("Invalid fixture");
    for (const patch of [
      { version: 2 },
      { profile: "bad" },
      { path: "/foreign" },
      { repository: "relative" },
      { origin: "file:///foreign" },
      { directoryIdentity: "replaced" },
      { repositoryIdentity: "replaced" },
      { extra: true },
    ]) {
      await writeFile(marker, JSON.stringify({ ...value, ...patch }));
      expect(await readWorktreeProvenance(path)).toBeUndefined();
    }
    for (const invalid of ["null", "[]", "{", " ".repeat(16385)]) {
      await writeFile(marker, invalid);
      expect(await readWorktreeProvenance(path)).toBeUndefined();
    }
    await writeFile(marker, text);
    await chmod(marker, 0o644);
    expect(await readWorktreeProvenance(path)).toBeUndefined();
    await chmod(marker, 0o600);
    await chmod(path, 0o777);
    expect(await readWorktreeProvenance(path)).toBeUndefined();
    await expect(writeWorktreeProvenance(profile, repository, path, origin)).rejects.toThrow();
    await chmod(path, 0o700);
    await rm(marker);
    await symlink(repository, marker);
    expect(await readWorktreeProvenance(path)).toBeUndefined();
    await rm(marker);
    await writeFile(marker, text, { mode: 0o600 });
    await rename(path, `${path}-old`);
    await symlink(`${path}-old`, path);
    expect(await readWorktreeProvenance(path)).toBeUndefined();
  },
);
