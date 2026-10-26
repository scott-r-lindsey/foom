import { git, record } from "./worktree-operations";
import type { WorktreeService } from "./worktrees";

export interface ReviewCheckout {
  head: string;
  branch: string;
  refs: string;
}
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

/** Local refs, including per-worktree refs; remote tracking updates are not reviewer work. */
export async function reviewRefs(path: string): Promise<string> {
  const refs = await git(path, ["for-each-ref", "--format=%(refname)%09%(objectname)"]);
  return refs
    .split("\n")
    .filter((ref) => !ref.startsWith("refs/remotes/"))
    .join("\n");
}

/** A creation record is necessary but never sufficient to authorize deletion. */
export async function unchangedReview(
  service: Pick<WorktreeService, "launchIdentity" | "listWorktrees" | "cleanupStatus">,
  repository: string,
  path: string,
  identity: string,
  review: ReviewCheckout,
): Promise<boolean> {
  try {
    if (!oid.test(review.head) || (await service.launchIdentity(repository, path)) !== identity)
      return false;
    const tree = (await service.listWorktrees(repository)).find((tree) => tree.path === path);
    if (
      !tree ||
      tree.branch !== null ||
      tree.head !== review.head ||
      tree.locked ||
      tree.prunable ||
      tree.bare
    )
      return false;
    if (
      (await service.cleanupStatus(repository, path, identity, review.head, true, review.head)) !==
      ""
    )
      return false;
    const logging = await git(path, [
      "config",
      "--type=bool",
      "--get",
      "core.logAllRefUpdates",
    ]).catch((error: unknown) => {
      if (record(error) && error["code"] === 1) return "true";
      throw error;
    });
    if (logging.trim() !== "true") return false;
    // cleanupStatus reads every private reflog (both old and new OIDs) and
    // verifies its history against the captured head, including reset-away commits.
    const baseline = new Set(review.refs.trim().split("\n"));
    const changedRefs = (await reviewRefs(path))
      .trim()
      .split("\n")
      .filter((ref) => ref && !baseline.has(ref));
    const tips = [...new Set(changedRefs.map((ref) => ref.split("\t")[1] ?? ""))];
    if (tips.some((tip) => !oid.test(tip))) return false;
    if (
      tips.length &&
      (
        await git(path, [
          "-c",
          "core.commitGraph=false",
          "rev-list",
          "--count",
          ...tips,
          "--not",
          review.head,
          "--",
        ])
      ).trim() !== "0"
    )
      return false;
    // Reread after the asynchronous proof; callers repeat this next to removal too.
    return (
      (await service.launchIdentity(repository, path)) === identity &&
      (await git(path, ["rev-parse", "--verify", "HEAD"])).trim() === review.head &&
      (await git(path, ["rev-parse", "--symbolic-full-name", "HEAD"])).trim() === "HEAD" &&
      (await service.cleanupStatus(repository, path, identity, review.head, true, review.head)) ===
        ""
    );
  } catch {
    return false;
  }
}
