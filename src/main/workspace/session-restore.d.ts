import type { OrchestrationEntry, WorkspaceTerminal } from "../../shared/workspace";

export interface OwnedWorktree {
  path: string;
  identity: string;
  state: "unused" | "used";
}

/** Main-owned launch provenance. Never supplied by hooks, IPC, or conversation metadata. */
export interface StoredSession extends WorkspaceTerminal {
  running?: boolean;
  orchestrator?: {
    identity: string;
    history: readonly OrchestrationEntry[];
    worktrees?: readonly OwnedWorktree[];
    uncertain?: number;
  };
  parentId?: string;
}
