import type { ForgeSampleContext } from "./forge-lifecycle-types";
import type { BoardPullRequest } from "../../shared/forge";
export interface PullRequest {
  number: number;
  headSha: string;
  mergeCommit?: string;
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

export interface ForgeResponse {
  code: number;
  stdout: string;
  stderr: string;
}
/** Main supplies bounded execFile-style execution; the interpreter never spawns. */
export type ForgeTransport = (argv: readonly string[]) => Promise<ForgeResponse>;
export interface ForgeRemote {
  host: string;
  project: string;
}
export interface ForgeBindings extends ForgeRemote {
  branch?: string;
  number?: number;
  nodeId?: string;
  query?: string;
  projectOwner?: string;
  projectName?: string;
}

export type ForgeProviderFactory = (
  remote: string,
  context?: () => Promise<ForgeSampleContext>,
) => ForgeProvider | undefined | Promise<ForgeProvider | undefined>;
