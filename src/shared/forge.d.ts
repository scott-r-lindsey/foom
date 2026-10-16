/** Validated, main-owned GitHub display metadata; never grants a capability. */
export interface BoardPullRequest {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  checks: { passed: number; failed: number; pending: number } | null;
}
