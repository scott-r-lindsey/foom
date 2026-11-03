import { lstat, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { assertInside, parentIdentity, record } from "./worktree-operations";
import type { PendingRemoval } from "./worktree-state.d";

export class RetryRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
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
  if ((await registeredPaths()).includes(entry.path)) refuse("re-registered");
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
