/** The checkout may exist although creation reported an error. */
export class UncertainEffect extends Error {}

/** Public removal diagnostics are fixed product text, never subprocess output. */
export const removalReasons = {
  not_found: "The worktree is no longer registered.",
  not_owned: "This orchestrator does not own the worktree.",
  locked: "The worktree is locked.",
  prunable: "The worktree needs pruning.",
  main_checkout: "The main checkout cannot be removed.",
  identity_changed: "Worktree has been replaced or redirected. Review it and try again.",
  detached_head: "Detached HEAD is not reachable from a local branch, remote-tracking ref or tag.",
  dirty: "Tracked changes were not approved for deletion.",
  untracked_files: "Untracked files were not approved for deletion.",
  changes_changed: "Worktree changes have changed. Review them and try again.",
  busy: "A session or operation is using the worktree.",
  user_declined: "The removal confirmation was declined or unavailable.",
  git_failed: "Git could not complete worktree removal.",
} as const;

export type RemovalReason = keyof typeof removalReasons;

export class RemovalError extends Error {
  constructor(
    readonly reason: RemovalReason,
    message: string = removalReasons[reason],
  ) {
    super(message);
  }
}
