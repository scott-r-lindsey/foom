export type BoardState = "working" | "checking" | "needs_input" | "done" | "failed" | "quiet_ok";
export interface BoardRow {
  agentWorking?: boolean;
  id: string;
  managed?: boolean;
  repositoryPath?: string;
  worktree?: string;
  exited?: boolean;
  worktreeRemoved?: boolean;
  /** Known bypass argument present at launch; does not infer global agent policy. */
  bypass?: boolean;
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
