import { expect, test } from "vitest";
import {
  ApplicationError,
  applicationErrorCode,
  errorMessage,
} from "../../../src/shared/application-errors";

test("only the closed codes select fixed messages, with or without Electron's wrapper", () => {
  const cases = [
    ["remote-host-unavailable", "Remote host artifact unavailable in this local build."],
    ["session-busy", "This session is busy. Try again when its current action finishes."],
    ["session-running", "Stop this session before closing it."],
    [
      "session-remote-unreachable",
      "Remote host unreachable. Reconnect before closing this session.",
    ],
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

test("child counts cross IPC only as positive safe integers with a closed reason", () => {
  for (const count of [1, 3, Number.MAX_SAFE_INTEGER]) {
    const error = new ApplicationError("session-has-children", count);
    expect(applicationErrorCode(error)).toBe("session-has-children");
    expect(
      errorMessage(
        new Error(
          `Error invoking remote method 'workspace:sidebar-command': Error: ${error.message}`,
        ),
      ),
    ).toBe(`Close its ${String(count)} ${count === 1 ? "child" : "children"} first.`);
  }
  for (const count of [undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => new ApplicationError("session-has-children", count)).toThrow(
      "Invalid application error details",
    );
  expect(() => new ApplicationError("session-busy", 1)).toThrow(
    "Invalid application error details",
  );
  for (const suffix of [
    "",
    ":0",
    ":-1",
    ":1.5",
    ":01",
    ":1e2",
    ":NaN",
    ":9007199254740992",
    ":99999999999999999",
    ":3:extra",
    ":3\nraw error",
    ":3\n",
  ])
    expect(
      errorMessage(new Error(`foom-error:session-has-children${suffix}`), "Close failed."),
    ).toBe("Close failed.");
  expect(errorMessage(new Error("foom-error:session-busy:3"), "Close failed.")).toBe(
    "Close failed.",
  );
});
