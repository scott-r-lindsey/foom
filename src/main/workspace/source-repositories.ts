import { lstat, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { ControlError } from "../../shared/control-validation";
import { dispatcherRepositoryPath } from "../../shared/dispatcher-validation";
import type { Repository } from "../../shared/worktrees";
import type { RepositoryPage } from "../control/types";
import { git, within, worktreeIdentity } from "./worktree-operations";

type Registry = () => readonly Repository[];

function repositoryName(directory: string, path: string): string {
  return within(directory, path) ? relative(directory, path) || "." : path;
}

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
  const entry = await lstat(marker).catch(() => undefined);
  if (!entry || !(entry.isDirectory() || entry.isFile())) throw new ControlError("not_found");
  const root = await git(path, ["rev-parse", "--show-toplevel"], 3000, undefined, true)
    .then((result) => realpath(result.slice(0, -1)))
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
  return { name: repositoryName(directory, path), path, identity };
}

export async function sourceRepositories(
  registry: Registry,
  directory: string,
  page?: RepositoryPage,
) {
  // Sort the in-memory registrations before checking Git so a page only verifies
  // its cursor and as many checkouts as it needs.
  const candidates = registry()
    .map(({ path }) => ({ path, name: repositoryName(directory, path) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const after = page?.after;
  const start = after === undefined ? 0 : candidates.findIndex(({ path }) => path === after);
  if (start < 0) throw new ControlError("not_found");

  const repositories: Awaited<ReturnType<typeof sourceRepository>>[] = [];
  for (const { path } of candidates.slice(start)) {
    if (page?.signal?.aborted) throw new ControlError("unavailable");
    const repo = await sourceRepository(registry, directory, path).catch((error: unknown) => {
      if (
        error instanceof ControlError &&
        (error.code === "not_found" || error.code === "invalid_request")
      )
        return undefined;
      throw error;
    });
    if (path === after) {
      if (!repo) throw new ControlError("not_found");
    } else if (repo) {
      repositories.push(repo);
      if (repositories.length === page?.take) break;
    }
  }
  if (page?.signal?.aborted) throw new ControlError("unavailable");
  return repositories;
}
