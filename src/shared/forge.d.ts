/** Validated, main-owned forge display metadata; never grants a capability. */
export interface BoardPullRequest {
  number: number;
  title?: string;
  url?: string;
  sourceName?: string;
  checksMeaning?: "required" | "head-pipeline" | "commit-status";
  requiredChecks?: "pending" | "success" | "failure" | "none" | "unknown";
  state: "OPEN" | "CLOSED" | "MERGED";
  checks: { passed: number; failed: number; pending: number } | null;
}
