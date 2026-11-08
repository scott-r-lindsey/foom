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

/** Main-only capability. Only a live holder may borrow its checkout reservation. */
export interface CheckoutHold {
  readonly path: string;
  readonly release: () => void;
}

/** Canonical paths, independent of mutable Git branch names and filesystem identity. */
export class CheckoutHolds {
  private readonly paths = new Map<string, Set<CheckoutHold>>();

  busy(path: string, parent?: CheckoutHold): boolean {
    const holders = this.paths.get(path);
    return holders !== undefined && !(parent?.path === path && holders.has(parent));
  }

  acquire(path: string, parent?: CheckoutHold): CheckoutHold | undefined {
    const current = this.paths.get(path);
    if (parent && (parent.path !== path || !current?.has(parent))) return;
    if (current && !parent) return;
    const holders = current ?? new Set<CheckoutHold>();
    const hold: CheckoutHold = {
      path,
      release: () => {
        if (!holders.delete(hold)) return;
        if (holders.size === 0 && this.paths.get(path) === holders) this.paths.delete(path);
      },
    };
    holders.add(hold);
    this.paths.set(path, holders);
    return hold;
  }
}

/** Branch reservations protect creation; path leases protect every known checkout. */
export function checkoutBusy(
  holds: CheckoutHolds,
  sessions: Iterable<WorkspaceTerminal>,
  key: string,
  checkout: string | undefined,
  parent?: CheckoutHold,
): boolean {
  return (
    (checkout !== undefined && holds.busy(checkout, parent)) ||
    closingWorktree(sessions, key, checkout)
  );
}
