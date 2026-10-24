import { git } from "./worktree-operations";
import type { BranchCleanupDependencies } from "./worktree-state.d";

export class WorktreeBranchCleanup {
  constructor(private readonly dependencies: BranchCleanupDependencies) {}
  async deleteMergedBranch(repository: string, branch: string, head: string): Promise<void> {
    await this.dependencies.validateBranch(repository, branch);
    if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error("Invalid commit ID");
    if ((await this.dependencies.listWorktrees(repository)).some((tree) => tree.branch === branch))
      throw new Error("Branch is checked out; kept its local ref");
    // Compare-and-delete atomically, unlike branch -D's unconditional ref deletion.
    // This also removes squash-merged refs without an ancestry-based merged check.
    await git(repository, ["update-ref", "--no-deref", "-d", `refs/heads/${branch}`, head]);
  }

  async deleteMergedBranches(
    repository: string,
    branches: readonly { branch: string; head: string }[],
  ): Promise<readonly string[]> {
    const checkedOut = new Set(
      (await this.dependencies.listWorktrees(repository)).map((tree) => tree.branch),
    );
    const kept: string[] = [];
    const commands: string[] = [];
    for (const { branch, head } of branches) {
      await this.dependencies.validateBranch(repository, branch);
      if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error("Invalid commit ID");
      const current = await git(repository, [
        "rev-parse",
        "--verify",
        `refs/heads/${branch}`,
      ]).catch(() => "");
      if (checkedOut.has(branch) || current.trim() !== head) kept.push(branch);
      else commands.push(`delete refs/heads/${branch} ${head}`);
    }
    if (commands.length) {
      // One transaction locks refs together. A race aborts it; preserve every ref on failure.
      try {
        await git(
          repository,
          ["update-ref", "--no-deref", "--stdin"],
          30_000,
          ["start", ...commands, "prepare", "commit", ""].join("\n"),
        );
      } catch {
        return branches.map((item) => item.branch);
      }
    }
    return kept;
  }
}
