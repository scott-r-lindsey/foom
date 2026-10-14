export interface PullRequest {
  number: number;
  headSha: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  requiredChecks: "pending" | "success" | "failure" | "none";
}
export interface AdoptionHead {
  branch: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  sameRepository: boolean;
}
export interface ForgeProvider {
  resolve?(number: number): Promise<AdoptionHead | undefined>;
  /** Branch lookup is also reusable by PR-aware worktree creation (#337). */
  lookup(branch: string, number?: number, state?: "open" | "all"): Promise<PullRequest | undefined>;
}
export interface ForgeWorktree {
  repository: string;
  path: string;
  identity: string;
  branch: string;
}
