export interface PullRequest {
  number: number;
  headSha: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  requiredChecks: "pending" | "success" | "failure" | "none";
}
export interface ForgeProvider {
  /** Branch lookup is also reusable by PR-aware worktree creation (#337). */
  lookup(branch: string, number?: number): Promise<PullRequest | undefined>;
}
export interface ForgeWorktree {
  repository: string;
  path: string;
  identity: string;
  branch: string;
}
