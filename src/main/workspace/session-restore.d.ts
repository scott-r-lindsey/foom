import type { OrchestrationEntry, WorkspaceTerminal } from "../../shared/workspace";

/** Main-owned launch provenance. Never supplied by hooks, IPC, or conversation metadata. */
export interface StoredSession extends WorkspaceTerminal {
  running?: boolean;
  orchestrator?: { identity: string; history: readonly OrchestrationEntry[] };
  parentId?: string;
}
