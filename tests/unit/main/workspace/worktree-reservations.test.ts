import { expect, it, test } from "vitest";
import {
  closingWorktree,
  worktreeReservation,
} from "../../../../src/main/workspace/worktree-reservations";
import type { WorkspaceTerminal } from "../../../../src/shared/workspace";

const session: WorkspaceTerminal = {
  id: "closing",
  kind: "agent",
  agent: "claude",
  repository: "/repo",
  worktree: "/tree",
  branch: "feature",
  attention: "evaluator",
  state: null,
  closeState: "closing",
};

test("closing checkout reservations cover local, detached and remote launch routes", () => {
  for (const key of [
    worktreeReservation("/repo", "/tree", "feature"),
    "/repo\0:remote:/tree",
    "/repo\0/tree",
    "remote-main\0/tree",
  ])
    expect(closingWorktree([session], key, undefined)).toBe(true);
  expect(
    closingWorktree(
      [{ ...session, branch: null }],
      worktreeReservation("/repo", "/tree", null),
      undefined,
    ),
  ).toBe(true);
  expect(closingWorktree([session], "/repo\0other", undefined)).toBe(false);
  expect(closingWorktree([{ ...session, closeState: "failed" }], "/repo\0feature", undefined)).toBe(
    false,
  );
});

it("reserves named branches together and detached paths independently", () => {
  expect(worktreeReservation("repo", "one", "feature")).toBe(
    worktreeReservation("repo", "two", "feature"),
  );
  expect(worktreeReservation("repo", "one", null)).not.toBe(
    worktreeReservation("repo", "two", null),
  );
  expect(worktreeReservation("repo", "one", undefined)).toBe(
    worktreeReservation("repo", "one", null),
  );
  expect(worktreeReservation("repo", "one", null)).not.toBe(
    worktreeReservation("other", "one", null),
  );
});

test.each(["renamed", null])(
  "canonical checkout holds survive branch %s independently of the old branch key",
  (branch) => {
    const key = worktreeReservation("/repo", "/tree", branch);
    expect(closingWorktree([session], key, "/tree")).toBe(true);
    expect(closingWorktree([session], key, "/unrelated")).toBe(false);
    expect(closingWorktree([{ ...session, closeState: "failed" }], key, "/tree")).toBe(false);
  },
);
