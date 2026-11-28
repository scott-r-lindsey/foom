import { lstat, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { ControlError } from "../../shared/control-validation";
import { dispatcherRepositoryPath } from "../../shared/dispatcher-validation";
import type { Repository } from "../../shared/worktrees";
import { git, within, worktreeIdentity } from "./worktree-operations";

type Registry = () => readonly Repository[];

/** Pin the directory itself as well as the canonical path. */
export async function sourceDirectoryIdentity(path: string): Promise<string> {
  const entry = await lstat(path, { bigint: true }).catch(() => undefined);
  if (!entry?.isDirectory() || (await realpath(path).catch(() => undefined)) !== path)
    throw new ControlError("not_found");
  return [entry.dev, entry.ino, entry.birthtimeNs].map(String).join(":");
}

export async function sourceRepository(registry: Registry, directory: string, value: unknown) {
  const path = dispatcherRepositoryPath(value);
  const registered = registry().find((row) => row.path === path);
  if (!registered) throw new ControlError("not_found");
  const marker = join(path, ".git");
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
    // The registry retains its row object until the registration changes.
    !registry().includes(registered)
  )
    throw new ControlError("conflict");
  const name = within(directory, path) ? relative(directory, path) || "." : path;
  return { name, path, identity };
}

export async function sourceRepositories(registry: Registry, directory: string) {
  const repositories: Awaited<ReturnType<typeof sourceRepository>>[] = [];
  for (const { path } of registry()) {
    const repo = await sourceRepository(registry, directory, path).catch((error: unknown) => {
      if (
        error instanceof ControlError &&
        (error.code === "not_found" || error.code === "invalid_request")
      )
        return undefined;
      throw error;
    });
    if (repo) repositories.push(repo);
  }
  return repositories.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}
