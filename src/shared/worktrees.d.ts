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
  readonly managed: boolean;
}

export interface CreateWorktreeOptions {
  readonly location?: "root" | "adjacent";
}
