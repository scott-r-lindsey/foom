/** Main-owned, opt-in automation for an orchestrator's child. */
export interface ReviewOptions {
  model?: string;
  effort?: string;
  rounds: number;
  agent: string;
  postFindings: boolean;
  /** Minutes to wait for the owning parent after an author blocks (default 180). */
  parentWaitMinutes?: number;
}

export interface ReviewFinding {
  file: string;
  line: number;
  summary: string;
  scenario: string;
}

/** Child-authored data, never instructions to Foom. */
export type ReviewVerdict =
  | { verdict: "clean" }
  | { verdict: "findings"; findings: readonly ReviewFinding[] };

export type ReviewReason =
  | "round cap"
  | "author blocked"
  | "author failed"
  | "reviewer blocked"
  | "reviewer failed"
  | "missing handoff"
  | "missing verdict"
  | "checks not green"
  | "worktree changed"
  | "launch failed"
  | "resume unavailable"
  | "stopped"
  | "restored";

export interface ReviewState extends ReviewOptions {
  /** Latest accepted child-authored verdict; untrusted data. */
  lastVerdict?: ReviewVerdict;
  pullRequest?: number;
  authorId: string;
  round: number;
  phase: "building" | "reviewing" | "fixing" | "waiting-on-parent" | "clean" | "escalated";
  reason?: ReviewReason;
  waiting?: boolean;
}
