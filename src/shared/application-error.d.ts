/** Closed vocabulary for errors crossing a desktop capability boundary. */
export type ApplicationErrorCode =
  | "remote-host-unavailable"
  | "operation-failed"
  | "worktree-prunable"
  | "worktree-locked"
  | "worktree-missing"
  | "worktree-main"
  | "prune-unsafe";
