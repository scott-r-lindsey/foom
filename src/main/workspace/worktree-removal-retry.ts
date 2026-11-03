import { lstat, realpath } from "node:fs/promises";
import { join, relative, sep, win32 } from "node:path";
import { assertInside, parentIdentity, record } from "./worktree-operations";
import type { PendingRemoval } from "./worktree-state.d";

export class RetryRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Conservative membership refusal only: never use case folding to grant deletion. */
export function sameRemovalPath(
  left: string,
  right: string,
  windows = process.platform === "win32",
): boolean {
  if (!windows) return left === right;
  const key = (path: string) => win32.normalize(win32.toNamespacedPath(path)).toLowerCase();
  return key(left) === key(right);
}

/** A creation-time directory identity grants only this narrow, revalidated exception. */
export async function checkRemovalRetry(
  entry: PendingRemoval,
  configuredRoot: string,
  registeredPaths: () => Promise<readonly string[]>,
): Promise<"missing" | "present"> {
  const refuse = (reason: string): never => {
    throw new RetryRefusal(reason);
  };
  let root: string;
  try {
    root = await realpath(configuredRoot);
    if (root !== entry.root) refuse("outside-root");
    assertInside(root, entry.path);
  } catch {
    return refuse("outside-root");
  }
  // Query every known repository; unavailable membership never means unregistered.
  for (const path of await registeredPaths()) {
    if (sameRemovalPath(path, entry.path)) refuse("re-registered");
    // Git may spell an existing checkout with an NTFS short name or another alias.
    const canonical = await realpath(path).catch((error: unknown) => {
      if (record(error) && error["code"] === "ENOENT") return undefined;
      return refuse("membership-unavailable");
    });
    if (canonical && sameRemovalPath(canonical, entry.path)) refuse("re-registered");
  }
  let current = root;
  const parts = relative(root, entry.path).split(sep);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstat(current).catch((error: unknown) => {
      if (record(error) && error["code"] === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return "missing";
    if (stat.isSymbolicLink())
      refuse(index === parts.length - 1 ? "symlink" : "symlinked-ancestor");
    if (!stat.isDirectory()) refuse("not-directory");
  }
  if ((await parentIdentity(entry.path)) !== entry.directoryIdentity) refuse("inode-mismatch");
  const marker = await lstat(join(entry.path, ".git")).catch((error: unknown) => {
    if (record(error) && error["code"] === "ENOENT") return undefined;
    throw error;
  });
  if (marker) refuse("git-present");
  return "present";
}
