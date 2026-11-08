import { expect, it } from "vitest";
import { worktreeReservation } from "../../../../src/main/workspace/worktree-reservations";

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
