export type CleanupReason =
  | "main checkout"
  | "unavailable"
  | "running"
  | "resumable conversation"
  | "uncommitted changes"
  | "not merged"
  | "worktree changed"
  | "not started"
  | "removal failed"
  | "fetch failed"
  | "branch kept";
export interface CleanupItem {
  id: string;
  path: string;
  branch: string;
  state: "queued" | "removing" | "removed" | "kept" | "error";
  reason?: CleanupReason;
  /** Bounded untracked paths reviewed before force removal. */
  changes?: string;
}
export interface CleanupProgress {
  id?: string;
  total: number;
  done: number;
  phase: "fetch" | "remove" | "finished";
  stopped: boolean;
  items: readonly CleanupItem[];
}
export interface CleanupDialog {
  checkingCount?: number;
  fetchedAt?: number;
  error?: "fetch failed";
  stage: "checking" | "ready" | "run";
  progress: Omit<CleanupProgress, "items"> & { items: readonly Omit<CleanupItem, "path">[] };
}
/** Main-only capability, never sent over IPC. */
export interface CleanupFeed {
  current(): CleanupDialog;
  subscribe(listener: () => void): () => void;
  act(): void;
}
