import type { CopyableErrorId, ApplicationErrorCode } from "./application-error";

const messages = {
  "remote-host-unavailable": "Remote host artifact unavailable in this local build.",
  "session-has-children": "Close its children first.",
  "session-busy": "This session is busy. Try again when its current action finishes.",
  "session-running": "Stop this session before closing it.",
  "session-remote-unreachable": "Remote host unreachable. Reconnect before closing this session.",
  "operation-failed": "Unable to complete this action.",
  "worktree-prunable": "This worktree needs pruning.",
  "worktree-locked": "This worktree is locked.",
  "worktree-missing": "This worktree is missing.",
  "worktree-removal-incomplete": "Worktree removal is incomplete. Manual cleanup is required.",
  "worktree-main": "The main checkout cannot be removed.",
  "prune-unsafe": "This folder cannot be safely pruned.",
} satisfies Record<ApplicationErrorCode, string>;

/** Only this class grants a code in main; arbitrary exception text never does. */
export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    childCount?: number,
  ) {
    if (
      (code === "session-has-children") !== (childCount !== undefined) ||
      (childCount !== undefined && (!Number.isSafeInteger(childCount) || childCount < 1))
    )
      throw new Error("Invalid application error details");
    super(`foom-error:${code}${childCount === undefined ? "" : `:${String(childCount)}`}`);
  }
}

/** Only main's validated removal target may supply this narrowly scoped detail. */
export class IncompleteRemovalError extends ApplicationError {
  constructor(readonly path: string) {
    super("worktree-removal-incomplete");
    if (!validRemovalPath(path)) throw new Error("Invalid removal path");
    this.message += `:${encodeURIComponent(path)}`;
  }
}

function validRemovalPath(path: string): boolean {
  return path.length <= 32768 && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(path) && !path.includes("\0");
}

function isApplicationErrorCode(value: unknown): value is ApplicationErrorCode {
  return typeof value === "string" && Object.hasOwn(messages, value);
}

/** Electron preserves only an Error's message, optionally wrapping it once. */
function applicationErrorDetails(
  error: unknown,
): { code: ApplicationErrorCode; childCount?: number; path?: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const match =
    /^(?:Error invoking remote method '[^']+': (?:Error: )?)?foom-error:([a-z-]+)(?::([^\r\n]*))?$/u.exec(
      error.message,
    );
  if (!match || match[0] !== error.message) return undefined;
  const code = match[1];
  if (!isApplicationErrorCode(code)) return undefined;
  const count = match[2];
  if (code === "worktree-removal-incomplete" && count !== undefined) {
    try {
      const path = decodeURIComponent(count);
      return validRemovalPath(path) && encodeURIComponent(path) === count
        ? { code, path }
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (code === "session-has-children") {
    const childCount = Number(count);
    return count !== undefined &&
      /^[1-9][0-9]{0,15}$/u.test(count) &&
      Number.isSafeInteger(childCount) &&
      childCount > 0
      ? { code, childCount }
      : undefined;
  }
  return count === undefined ? { code } : undefined;
}

export function applicationErrorCode(error: unknown): ApplicationErrorCode | undefined {
  return applicationErrorDetails(error)?.code;
}

export function errorMessage(error: unknown, fallback = messages["operation-failed"]): string {
  const details = applicationErrorDetails(error);
  if (details?.code === "session-has-children")
    return `Close its ${String(details.childCount)} ${details.childCount === 1 ? "child" : "children"} first.`;
  if (details?.code === "worktree-removal-incomplete" && details.path)
    return `Worktree removal is incomplete. Manually clean up: ${details.path}`;
  const code = details?.code;
  return code && code !== "operation-failed" ? messages[code] : fallback;
}

/** Fixed UI sentences may be copied by ID; no exception or renderer text is accepted. */
export const copyableErrorText = {
  ...messages,
  "unable-to-update-settings": "Unable to update settings.",
  "could-not-restart-foom": "Could not restart Foom.",
  "network-change-failed": "Network change failed",
  "reload-failed": "Reload failed",
  "the-tile-layout-has-reached-its-size-limit": "The tile layout has reached its size limit.",
  "unable-to-add-repository": "Unable to add repository.",
  "unable-to-clean-up-worktree": "Unable to clean up worktree.",
  "unable-to-clear-the-action-log": "Unable to clear the action log.",
  "unable-to-close-session": "Unable to close session.",
  "unable-to-copy": "Unable to copy",
  "unable-to-copy-config-path": "Unable to copy config path.",
  "unable-to-copy-home-path": "Unable to copy home path.",
  "unable-to-copy-session-id": "Unable to copy session ID.",
  "unable-to-copy-worktree-path": "Unable to copy worktree path.",
  "unable-to-create-the-worktree": "Unable to create the worktree.",
  "unable-to-delete-merged-worktrees": "Unable to delete merged worktrees.",
  "unable-to-launch-foom-config": "Unable to launch Foom config.",
  "unable-to-launch-session": "Unable to launch session.",
  "unable-to-make-orchestrator": "Unable to make orchestrator.",
  "unable-to-move-tile-to-a-new-window": "Unable to move tile to a new window.",
  "unable-to-move-tile-to-window": "Unable to move tile to window.",
  "unable-to-open-application-menu": "Unable to open application menu.",
  "unable-to-open-link": "Unable to open link.",
  "unable-to-open-preview": "Unable to open preview.",
  "unable-to-open-pull-request": "Unable to open pull request.",
  "unable-to-open-settings": "Unable to open Settings.",
  "unable-to-open-themes-folder": "Unable to open themes folder.",
  "unable-to-prune-worktree": "Unable to prune worktree.",
  "unable-to-record-feedback-try-again": "Unable to record feedback. Try again.",
  "unable-to-remove-repository": "Unable to remove repository.",
  "unable-to-remove-worktree": "Unable to remove worktree.",
  "unable-to-restart-shell": "Unable to restart shell.",
  "unable-to-resume-conversation": "Unable to resume conversation.",
  "unable-to-revoke-orchestrator": "Unable to revoke orchestrator.",
  "unable-to-run-this-command": "Unable to run this command.",
  "unable-to-select-terminal-window": "Unable to select terminal window.",
  "unable-to-show-keyboard-shortcuts": "Unable to show keyboard shortcuts.",
  "unable-to-start-conversation": "Unable to start conversation.",
  "unable-to-start-shell": "Unable to start shell.",
  "unable-to-stop-session": "Unable to stop session.",
  "unable-to-take-over-session": "Unable to take over session.",
  "unable-to-update-foom-config": "Unable to update Foom config.",
  "git-is-unavailable-install-git-and-recheck-on-go-no-go":
    "Git is unavailable. Install Git and recheck on Go / no-go.",
  "invalid-sound-choice": "Invalid sound choice",
  "invalid-sound-configuration": "Invalid sound configuration",
  "invalid-sound-file-choice": "Invalid sound file choice",
  "invalid-sound-kind": "Invalid sound kind",
  "invalid-sound-switches": "Invalid sound switches",
  "invalid-sound-volume": "Invalid sound volume",
  "needs-you-must-use-a-different-file-from-done-and-refusal":
    "Needs you must use a different file from Done and Refusal",
  "unable-to-close-preview": "Unable to close preview.",
  "unable-to-open-sounds-folder": "Unable to open sounds folder",
  "unable-to-read-sound-credits": "Unable to read sound credits",
  "unable-to-update-repositories": "Unable to update repositories.",
};
export function isCopyableErrorId(value: unknown): value is CopyableErrorId {
  return typeof value === "string" && Object.hasOwn(copyableErrorText, value);
}
export function copyableErrorId(message: string): CopyableErrorId | undefined {
  for (const key of Object.keys(copyableErrorText)) {
    if (isCopyableErrorId(key) && copyableErrorText[key] === message) return key;
  }
  return undefined;
}
