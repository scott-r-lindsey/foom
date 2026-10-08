import type { ExecutionSnapshot } from "../../shared/execution";
export type BoardState = "working" | "checking" | "needs_input" | "done" | "failed" | "quiet_ok";
export interface BoardRow {
  execution?: ExecutionSnapshot | undefined;
  id: string;
  managed?: boolean;
  repositoryPath?: string;
  worktree?: string;
  exited?: boolean;
  conversationId?: string | undefined;
  /** No host screen exists for a restored or failed-to-relaunch session. */
  dormant?: boolean;
  /** Changes when an exited terminal is relaunched under the same ID. */
  launchVersion?: number;
  worktreeRemoved?: boolean;
  /** Known bypass argument present at launch; does not infer global agent policy. */
  bypass?: boolean;
  /** Launched for review with invocation-scoped read-only flags. */
  readOnly?: boolean;
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
