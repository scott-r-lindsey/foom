import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { readOwnedFile } from "../../node-common/owned-files";
import { git, record } from "./worktree-operations";
import type { WorktreeService } from "./worktrees";

export interface ReviewCheckout {
  head: string;
  branch: string;
  refs: string;
  /** Missing on legacy records: never grants automatic deletion. */
  exclusions?: string;
}
const disposable = [
  "node_modules/",
  "build/",
  "out/",
  ".cache/",
  "test-results/",
  ".husky/_/",
  "coverage/",
];
const onlyDisposable = (status: string) =>
  status.split("\0").every((entry) => {
    if (!entry) return true;
    if (!entry.startsWith("!! ")) return false;
    const name = entry.slice(3);
    return (
      !name
        .split("/")
        .some((part) => part === "." || part === ".." || part.toLowerCase() === ".gitignore") &&
      disposable.some((prefix) => name.startsWith(prefix))
    );
  });

/** Pin local exclusion evidence without reading the file named by core.excludesFile. */
export async function reviewExclusions(path: string): Promise<string> {
  const inspect = (args: string[]) => git(path, args, 30_000, undefined, true);
  const config = await inspect(["config", "--null", "--get-all", "core.excludesFile"]).catch(
    (error: unknown) => {
      if (record(error) && error["code"] === 1) return "";
      throw error;
    },
  );
  const file = resolve(path, (await inspect(["rev-parse", "--git-path", "info/exclude"])).trim());
  const hash = createHash("sha256").update(JSON.stringify([file, config]));
  const stat = await lstat(file).catch((error: unknown) => {
    if (record(error) && error["code"] === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return hash.update("missing").digest("hex");
  const contents = await readOwnedFile(file, 65536, async (target) => {
    const entry = await lstat(target);
    if (!entry.isFile() || (await realpath(target)) !== target)
      throw new Error("Unsafe review exclusion evidence");
  });
  if (Buffer.byteLength(contents) !== stat.size) throw new Error("Review exclusions changed");
  return hash.update("file").update(contents).digest("hex");
}

/** Run beside both status reads, including the final removal proof. */
export async function assertReviewRules(path: string, exclusions: string): Promise<void> {
  if (
    (await reviewExclusions(path)) !== exclusions ||
    (await git(
      path,
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.excludesFile=",
        "ls-files",
        "--others",
        "-z",
        "--",
        ":(icase).gitignore",
        ":(icase,glob)**/.gitignore",
      ],
      30_000,
      undefined,
      true,
    )) !== ""
  )
    throw new Error("Review ignore rules changed");
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
    if (
      !review.exclusions ||
      !/^[a-f0-9]{64}$/u.test(review.exclusions) ||
      !oid.test(review.head) ||
      (await service.launchIdentity(repository, path)) !== identity
    )
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
      !onlyDisposable(
        await service.cleanupStatus(
          repository,
          path,
          identity,
          review.head,
          true,
          review.head,
          review.exclusions,
        ),
      )
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
      onlyDisposable(
        await service.cleanupStatus(
          repository,
          path,
          identity,
          review.head,
          true,
          review.head,
          review.exclusions,
        ),
      )
    );
  } catch {
    return false;
  }
}
