import type { ReviewOptions } from "../../shared/review";
import type { Handoff } from "../../shared/handoff";
import type { OrchestrationEntry, WorkspaceTerminal } from "../../shared/workspace";

export interface OwnedWorktree {
  path: string;
  identity: string;
  state: "unused" | "used";
  reviewer?: boolean;
  pullRequest?: number;
  review?: ReviewOptions;
  closedReviews?: readonly { id: string; handoffs: readonly Handoff[] }[];
}

/** Main-owned launch provenance. Never supplied by hooks, IPC, or conversation metadata. */
export interface RemoteSavedPlacement {
  repository: string;
  path: string;
  identity: string;
  branch: string;
}
export interface StoredSession extends WorkspaceTerminal {
  /** Private main-owned locator; never projected to the board. */
  remoteCheckout?: RemoteSavedPlacement;
  /** Transient discovery marker; never persisted or supplied to the renderer. */
  recovered?: true;
  handoffs?: readonly Handoff[];
  running?: boolean;
  orchestrator?: {
    identity: string;
    history: readonly OrchestrationEntry[];
    worktrees?: readonly OwnedWorktree[];
    uncertain?: number;
  };
  parentId?: string;
}
