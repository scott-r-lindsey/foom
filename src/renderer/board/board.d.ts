import type { Handoff } from "../../shared/handoff";
import type { McpConnection } from "../../shared/workspace";
import type { ExecutionSnapshot } from "../../shared/execution";
import type { OrchestrationView } from "../../shared/workspace";
export type BoardState = "waiting" | "working" | "needs_input" | "done" | "failed" | "quiet_ok";
export interface BoardRow {
  waitingOn?: number | undefined;
  /** Host-observed foreground process name; never persisted. */
  foregroundProgram?: string;
  execution?: ExecutionSnapshot | undefined;
  id: string;
  managed?: boolean;
  home?: boolean;
  /** Runs in the Foom config folder and nests under the Foom config row. */
  config?: boolean;
  startedAt?: number | undefined;
  exitCode?: number | undefined;
  launchFlags?: readonly string[] | undefined;
  /** Names of the variables Foom set from Environment settings; never values. */
  environment?: readonly string[] | undefined;
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
  /** Main's orchestrator role and action history, or a child's parent and takeover. */
  mcpConnection?: McpConnection | undefined;
  orchestration?: OrchestrationView | undefined;
  handoff?: Handoff | undefined;
  roleNotRestored?: boolean | undefined;
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
