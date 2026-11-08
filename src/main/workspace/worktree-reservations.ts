import type { WorkspaceTerminal } from "../../shared/workspace";

/** Named branches share a reservation; detached checkouts reserve only their own path. */
export function worktreeReservation(
  repository: string,
  path: string,
  branch: string | null | undefined,
): string {
  return `${repository}\0${branch ?? `:detached:${path}`}`;
}

/** Closing sessions retain their checkout until cleanup has settled. */
export function closingWorktree(
  sessions: Iterable<WorkspaceTerminal>,
  key: string,
  checkout: string | undefined,
): boolean {
  return [...sessions].some(
    (entry) =>
      entry.closeState === "closing" &&
      // Inventory and session paths are main-owned canonical checkout locators.
      // A branch/HEAD or filesystem identity change cannot release this hold.
      ((checkout !== undefined && entry.worktree === checkout) ||
        worktreeReservation(entry.repository, entry.worktree, entry.branch) === key ||
        `${entry.repository}\0:remote:${entry.worktree}` === key ||
        `${entry.repository}\0${entry.worktree}` === key ||
        `remote-main\0${entry.worktree}` === key),
  );
}
