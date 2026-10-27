import type { ApplicationErrorCode } from "./application-error";

const messages = {
  "remote-host-unavailable": "Remote host artifact unavailable in this local build.",
  "operation-failed": "Unable to complete this action.",
  "worktree-prunable": "This worktree needs pruning.",
  "worktree-locked": "This worktree is locked.",
  "worktree-missing": "This worktree is missing.",
  "worktree-main": "The main checkout cannot be removed.",
  "prune-unsafe": "This folder cannot be safely pruned.",
} satisfies Record<ApplicationErrorCode, string>;

/** Only this class grants a code in main; arbitrary exception text never does. */
export class ApplicationError extends Error {
  constructor(readonly code: ApplicationErrorCode) {
    super(`foom-error:${code}`);
  }
}

function isApplicationErrorCode(value: unknown): value is ApplicationErrorCode {
  return typeof value === "string" && Object.hasOwn(messages, value);
}

/** Electron preserves only an Error's message, optionally wrapping it once. */
export function applicationErrorCode(error: unknown): ApplicationErrorCode | undefined {
  if (!(error instanceof Error)) return undefined;
  const match =
    /^(?:Error invoking remote method '[^']+': (?:Error: )?)?foom-error:([a-z-]+)$/u.exec(
      error.message,
    );
  const code = match?.[1];
  return isApplicationErrorCode(code) ? code : undefined;
}

export function errorMessage(error: unknown, fallback = messages["operation-failed"]): string {
  const code = applicationErrorCode(error);
  return code && code !== "operation-failed" ? messages[code] : fallback;
}
