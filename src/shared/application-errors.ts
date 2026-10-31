import type { ApplicationErrorCode } from "./application-error";

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

function isApplicationErrorCode(value: unknown): value is ApplicationErrorCode {
  return typeof value === "string" && Object.hasOwn(messages, value);
}

/** Electron preserves only an Error's message, optionally wrapping it once. */
function applicationErrorDetails(
  error: unknown,
): { code: ApplicationErrorCode; childCount?: number } | undefined {
  if (!(error instanceof Error)) return undefined;
  const match =
    /^(?:Error invoking remote method '[^']+': (?:Error: )?)?foom-error:([a-z-]+)(?::([1-9][0-9]{0,15}))?$/u.exec(
      error.message,
    );
  if (!match || match[0] !== error.message) return undefined;
  const code = match[1];
  if (!isApplicationErrorCode(code)) return undefined;
  const count = match[2];
  if (code === "session-has-children") {
    const childCount = Number(count);
    return Number.isSafeInteger(childCount) && childCount > 0 ? { code, childCount } : undefined;
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
  const code = details?.code;
  return code && code !== "operation-failed" ? messages[code] : fallback;
}
