import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { ControlError } from "../../shared/control-validation";
import { sourceRepositoryName } from "../../shared/dispatcher-validation";
import { git, worktreeIdentity } from "./worktree-operations";

const ENTRY_LIMIT = 4096;
const REPOSITORY_LIMIT = 128;

/** Pin the directory itself as well as the canonical path. */
export async function sourceDirectoryIdentity(path: string): Promise<string> {
  const entry = await lstat(path, { bigint: true }).catch(() => undefined);
  if (!entry?.isDirectory() || (await realpath(path).catch(() => undefined)) !== path)
    throw new ControlError("not_found");
  return [entry.dev, entry.ino, entry.birthtimeNs].map(String).join(":");
}

export async function sourceRepository(directory: string, value: unknown) {
  const name = sourceRepositoryName(value);
  const path = join(directory, name);
  const marker = join(path, ".git");
  const parent = await sourceDirectoryIdentity(directory);
  const before = await sourceDirectoryIdentity(path);
  if (!(await lstat(marker).catch(() => undefined))?.isDirectory())
    throw new ControlError("not_found");
  const root = await git(path, ["rev-parse", "--show-toplevel"], 3000, undefined, true)
    .then((result) => realpath(result.trimEnd()))
    .catch(() => undefined);
  if (root !== path) throw new ControlError("not_found");
  const identity = await worktreeIdentity(path).catch(() => undefined);
  if (
    identity === undefined ||
    (await realpath(marker).catch(() => undefined)) !== marker ||
    before !== (await sourceDirectoryIdentity(path)) ||
    parent !== (await sourceDirectoryIdentity(directory))
  )
    throw new ControlError("conflict");
  return { name, path, identity };
}

export async function sourceRepositories(directory: string) {
  const handle = await opendir(directory);
  const entries: string[] = [];
  let count = 0;
  for await (const entry of handle) {
    if (++count > ENTRY_LIMIT) throw new ControlError("capacity");
    if (!entry.isDirectory()) continue;
    try {
      entries.push(sourceRepositoryName(entry.name));
    } catch {
      // Hidden directories and names that cannot be passed to launch are excluded.
    }
  }
  const repositories: Awaited<ReturnType<typeof sourceRepository>>[] = [];
  for (const name of entries.sort()) {
    const repo = await sourceRepository(directory, name).catch((error: unknown) => {
      if (error instanceof ControlError && error.code === "not_found") return undefined;
      throw error;
    });
    if (!repo) continue;
    if (repositories.length >= REPOSITORY_LIMIT) throw new ControlError("capacity");
    repositories.push(repo);
  }
  return repositories;
}
