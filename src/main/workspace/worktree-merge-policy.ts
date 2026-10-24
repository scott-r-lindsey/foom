import type { Worktree } from "../../shared/worktrees";
import { pullRequest } from "../control/forge";
import {
  commitId,
  hintIntegratesHead,
  isAncestor,
  mergeMatchesTree,
  withMergeProof,
} from "./merge-proof";
import { git } from "./worktree-operations";
import type { MergePolicyDependencies } from "./worktree-state.d";

/** Deletion eligibility consumes fresh identity and isolated proof capabilities. */
export class WorktreeMergePolicy {
  constructor(private readonly dependencies: MergePolicyDependencies) {}
  /** Ancestry or a PR merge verified against the freshly fetched default. */
  async canAutoRemove(repository: string, path: string, identity: string): Promise<boolean> {
    try {
      await this.dependencies.checkRemovalIdentity(repository, path, identity);
      const base = await this.dependencies.mergedDefault(repository, true);
      const branch = (await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
      await this.dependencies.validateBranch(repository, branch);
      const head = (await git(path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
      if (!/^[a-f0-9]{40,64}$/u.test(head) || !/^[a-f0-9]{40,64}$/u.test(base)) return false;
      if (this.dependencies.fetchFacts(repository)?.branch === branch) return false;
      const tree = (await this.dependencies.listWorktrees(repository)).find(
        (item) => item.path === path,
      );
      if (!tree || tree.head !== head || tree.branch !== branch) return false;
      if (!(await this.verifiedPrMerge(repository, tree, base))) {
        // Preserve the no-unpushed-commits guard for the ancestry-only path.
        const upstream = (
          await git(path, ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`])
        ).trim();
        const unpushed = (
          await git(
            path,
            upstream
              ? ["rev-list", "--count", "HEAD", "--not", upstream, "--"]
              : ["rev-list", "--count", "HEAD", "--not", "--remotes", "--"],
          )
        ).trim();
        if (unpushed !== "0") return false;
        if (!(await withMergeProof(repository, (run) => isAncestor(run, head, base)))) return false;
      }
      if ((await this.dependencies.changes(repository, path, identity)) !== "") return false;
      return (
        (await git(path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim() === head &&
        (await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() === branch
      );
    } catch {
      // Missing refs, failed fetches, unsupported Git and identity changes never authorize removal.
      return false;
    }
  }

  async mergedCommit(repository: string, tree: Worktree, base: string): Promise<boolean> {
    const head = tree.head;
    if (
      !head ||
      (tree.branch !== null && this.dependencies.fetchFacts(repository)?.branch === tree.branch)
    )
      return false;
    if (tree.branch) await this.dependencies.validateBranch(repository, tree.branch);
    if (!commitId.test(base) || !commitId.test(head)) throw new Error("Invalid commit ID");
    try {
      if (await withMergeProof(repository, (run) => mergeMatchesTree(run, base, head, base)))
        return true;
    } catch {
      // A content conflict does not rule out an earlier PR merge.
    }
    return this.verifiedPrMerge(repository, tree, base);
  }

  /** Forge output is only a hint; never pass its unchecked values to Git. */
  private async verifiedPrMerge(
    repository: string,
    tree: Worktree,
    base: string,
  ): Promise<boolean> {
    try {
      if (
        !tree.branch ||
        !tree.head ||
        this.dependencies.fetchFacts(repository)?.branch === tree.branch
      )
        return false;
      const remote = await this.dependencies.forgeRemote(repository);
      const pr = pullRequest(
        await (remote === undefined
          ? undefined
          : (await this.dependencies.forgeProviderFor(repository, tree.path, remote))?.lookup(
              tree.branch,
              undefined,
              "all",
            )),
      );
      if (pr?.state !== "MERGED" || pr.headSha !== tree.head) return false;
      let integrated = false;
      for (const commit of new Set([pr.mergeCommit, pr.squashCommit])) {
        if (!commit) continue;
        if (!commitId.test(commit)) return false;
        if (await hintIntegratesHead(repository, commit, tree.head, base)) {
          integrated = true;
          break;
        }
      }
      if (!integrated) return false;
      return (
        (await git(tree.path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim() === tree.head &&
        (await this.dependencies.changes(repository, tree.path)) === ""
      );
    } catch {
      // Missing objects, malformed/hostile forge hints and unavailable providers fail closed.
      return false;
    }
  }
}
