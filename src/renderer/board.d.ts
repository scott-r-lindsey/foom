export type BoardState = "working" | "checking" | "needs_input" | "done" | "failed" | "quiet_ok";
export interface BoardRow {
  id: string;
  kind: "sample" | "shell" | "agent";
  repository: string;
  branch: string;
  agent: string;
  state: BoardState;
  reason: string;
  rate: number;
  waitingSince: number;
  seen: boolean;
  tail: string[];
  verdictId?: string | null;
}
