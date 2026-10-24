import { constants } from "node:fs";
import { lstat, open, realpath, stat as fileStat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ApplicationError } from "../../shared/application-errors";
import type { IdentityDependencies } from "./worktree-state.d";

/** Read only the checkout's own Git marker, never search ancestors or trust a cache.
 * Membership and common-directory authorization still use Git in checkoutIdentity. */
async function checkoutGitDirectory(path: string): Promise<string> {
  const marker = join(path, ".git");
  const markerMetadata = await fileStat(marker);
  if (markerMetadata.isDirectory()) return realpath(marker);
  if (!markerMetadata.isFile() || markerMetadata.size > 64 * 1024) {
    throw new Error("Invalid Git marker");
  }
  // Refuse special files before opening; recheck the descriptor in case the marker changed.
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;
  const handle = await open(marker, flags);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 64 * 1024) throw new Error("Invalid Git marker");
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 64 * 1024) throw new Error("Invalid Git marker");
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    if (!text.startsWith("gitdir: ") || text.includes("\0")) throw new Error("Invalid Git marker");
    const directory = text.slice(8).replace(/[\r\n]+$/u, "");
    if (!directory) throw new Error("Invalid Git marker");
    return await realpath(resolve(path, directory));
  } finally {
    await handle.close();
  }
}

// Bind confirmation to both the filesystem entries and Git's per-worktree metadata.
// Birth time distinguishes recreated entries even when the filesystem reuses an inode.
export async function worktreeIdentity(path: string): Promise<string> {
  const gitDirectory = await checkoutGitDirectory(path);
  const entries = await Promise.all(
    [path, join(path, ".git"), gitDirectory].map(async (entry) => {
      const stat = await lstat(entry, { bigint: true });
      return [stat.dev, stat.ino, stat.birthtimeNs].map(String);
    }),
  );
  return JSON.stringify([gitDirectory, entries]);
}

export async function checkoutIdentity(
  dependencies: IdentityDependencies,
  repositoryPath: string,
  path: string,
  allowMain: boolean,
): Promise<string> {
  dependencies.validatePath(path);
  const trees = await dependencies.listWorktrees(repositoryPath);
  const tree = trees.find((item) => item.path === path);
  if (!allowMain && path === repositoryPath) throw new ApplicationError("worktree-main");
  if (!tree || tree.bare) throw new ApplicationError("worktree-missing");
  if (tree.locked) throw new ApplicationError("worktree-locked");
  if (tree.prunable) throw new ApplicationError("worktree-prunable");
  if ((await dependencies.realpath(path)) !== path)
    throw new Error("Worktree path has been redirected");
  const commonDirectory = async (cwd: string) =>
    dependencies.realpath(
      (
        await dependencies.git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
      ).slice(0, -1),
    );
  const common = await commonDirectory(repositoryPath);
  const gitDirectory = await dependencies.realpath(
    (await dependencies.git(path, ["rev-parse", "--absolute-git-dir"])).slice(0, -1),
  );
  if ((!allowMain && gitDirectory === common) || (await commonDirectory(path)) !== common)
    throw new Error("Worktree is not a linked checkout of this repository");
  return worktreeIdentity(path);
}
