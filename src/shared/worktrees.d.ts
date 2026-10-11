export interface Repository {
  readonly path: string;
  readonly name: string;
}

export interface Worktree {
  readonly path: string;
  readonly head: string | null;
  readonly bare: boolean;
  readonly branch: string | null;
  readonly locked: boolean;
  readonly prunable: boolean;
  /** Historical creation record only; never an authorization requirement. */
  readonly managed: boolean;
}

export interface CreateWorktreeOptions {
  readonly location?: "root" | "adjacent";
  /** Require a new local branch from HEAD; never reuse or track existing refs (orchestrator children). */
  readonly newBranch?: boolean;
}

/** What creating a worktree for a branch did: `open` means it was already checked out. */
export type CreateOutcome = "new" | "existing" | "origin" | "open";

export interface CreatedWorktree {
  readonly path: string;
  readonly outcome: CreateOutcome;
}

/** Refs already present locally; reading them never fetches. */
export interface BranchInventory {
  /** The main checkout's branch; null when detached. */
  readonly head: string | null;
  /** Local branches and the checkout each is in, if any. */
  readonly local: readonly { readonly name: string; readonly worktree: string | null }[];
  readonly remote: string | null;
  /** The remote's branches, without the remote prefix. */
  readonly remoteBranches: readonly string[];
}
