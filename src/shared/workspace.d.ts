import type { AgentId, AgentInstallation } from "./agents";
import type { VerdictAction, VerdictState } from "./evaluator";
import type { Repository, Worktree } from "./worktrees";

/**
 * Main's latest view of a terminal's attention state. `verdictId` is null for user
 * actions and for verdicts that couldn't be stored.
 */
export interface TerminalState {
  id: string;
  verdictId: string | null;
  state: VerdictState;
  reason: string;
  signal: string;
  confidence: number;
  timestamp: number;
}

/** A terminal Foom launched in a managed worktree. Paths identify; the renderer never picks them. */
export interface WorkspaceTerminal {
  id: string;
  kind: "agent";
  agent: AgentId;
  repository: string;
  worktree: string;
  branch: string | null;
  attention: "hooks" | "evaluator";
  state: TerminalState | null;
}

export interface WorkspaceSnapshot {
  repositories: readonly Repository[];
  terminals: readonly WorkspaceTerminal[];
}

/** Scan results without the resolved PATH, which the renderer doesn't need. */
export interface AgentReport {
  warning: string | null;
  agents: readonly AgentInstallation[];
}

export interface LaunchRequest {
  agent: AgentId;
  repository: string;
  worktree: string;
  cols: number;
  rows: number;
  acknowledgeCodexNotifierReplacement?: boolean;
}

export interface WorkspaceApi {
  workspace(): Promise<WorkspaceSnapshot>;
  /** Main shows the directory picker; resolves null when the user cancels. */
  addRepository(): Promise<Repository | null>;
  worktrees(repository: string): Promise<readonly Worktree[]>;
  createWorktree(
    repository: string,
    branch: string,
    location: "root" | "adjacent",
  ): Promise<Worktree>;
  scanAgents(refresh: boolean): Promise<AgentReport>;
  launchAgent(request: LaunchRequest): Promise<{ id: string; attention: "hooks" | "evaluator" }>;
  /** Pass null only for the current verdict when it couldn't be stored. */
  feedback(id: string, verdictId: string | null, action: VerdictAction): Promise<void>;
  onState(callback: (state: TerminalState) => void): () => void;
}
