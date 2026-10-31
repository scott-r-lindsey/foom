import { expect, test } from "vitest";
import {
  ApplicationError,
  applicationErrorCode,
  errorMessage,
} from "../../../src/shared/application-errors";

test("only the closed codes select fixed messages, with or without Electron's wrapper", () => {
  const cases = [
    ["remote-host-unavailable", "Remote host artifact unavailable in this local build."],
    ["operation-failed", "Unable to complete this action."],
    ["worktree-prunable", "This worktree needs pruning."],
    ["worktree-locked", "This worktree is locked."],
    ["worktree-missing", "This worktree is missing."],
    ["worktree-main", "The main checkout cannot be removed."],
    ["prune-unsafe", "This folder cannot be safely pruned."],
  ] as const;
  for (const [code, sentence] of cases) {
    const error = new ApplicationError(code);
    expect(applicationErrorCode(error)).toBe(code);
    expect(errorMessage(error)).toBe(sentence);
    expect(
      errorMessage(
        new Error(
          `Error invoking remote method 'workspace:sidebar-command': Error: ${error.message}`,
        ),
      ),
    ).toBe(sentence);
    expect(
      errorMessage(
        new Error(`Error invoking remote method 'workspace:sidebar-command': ${error.message}`),
      ),
    ).toBe(sentence);
  }
  for (const error of [
    null,
    "foom-error:worktree-prunable",
    { message: "foom-error:worktree-prunable" },
    new Error("foom-error:unknown"),
    new Error("foom-error:__proto__"),
    new Error("foom-error:worktree-prunable\nraw details"),
    new Error(
      "Error invoking remote method 'workspace:sidebar-command': Error: /secret/path: token=secret",
    ),
  ]) {
    expect(applicationErrorCode(error)).toBeUndefined();
    expect(errorMessage(error, "Unable to remove worktree.")).toBe("Unable to remove worktree.");
  }
});

test("copyable errors resolve closed IDs and refuse arbitrary text or inherited properties", async () => {
  const { copyableErrorId, copyableErrorText, isCopyableErrorId } = await import(
    "../../../src/shared/application-errors"
  );
  for (const [id, message] of Object.entries(copyableErrorText)) {
    expect(isCopyableErrorId(id)).toBe(true);
    expect(copyableErrorId(message)).toBeDefined();
  }
  for (const value of ["__proto__", "constructor", "token=secret", null, 3])
    expect(isCopyableErrorId(value)).toBe(false);
  expect(copyableErrorId("arbitrary exception text")).toBeUndefined();
});
