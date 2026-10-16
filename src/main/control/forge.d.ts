import type { BoardPullRequest } from "../../shared/forge";
export interface PullRequest {
  number: number;
  headSha: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  requiredChecks: "pending" | "success" | "failure" | "none" | "unknown";
}
export interface AdoptionHead {
  branch: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  sameRepository: boolean;
}
export interface ForgeMatch {
  branch: string;
  number?: number;
}
export interface ForgeObservation extends PullRequest {
  board: BoardPullRequest;
}
export interface ForgeProvider {
  batch?(
    matches: readonly ForgeMatch[],
  ): Promise<ReadonlyMap<string, ForgeObservation> | undefined>;
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
