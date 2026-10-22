import { describe, expect, it } from "vitest";
import { isReviewState, reviewLabel } from "../../../../src/shared/review-state";
import type { ReviewState } from "../../../../src/shared/review";
import { readSessions } from "../../../../src/main/workspace/session-store";
import { restorePlan } from "../../../../src/main/workspace/session-restore";

const state: ReviewState = {
  authorId: "child",
  rounds: 3,
  round: 0,
  phase: "building",
  agent: "claude",
  postFindings: false,
};
describe("review presentation and safe restore", () => {
  it("shows every phase in words including capacity waits", () => {
    expect(reviewLabel(state)).toBe("Building");
    for (const phase of ["reviewing", "fixing"] as const) {
      expect(reviewLabel({ ...state, phase, round: 2 })).toBe(
        `${phase === "reviewing" ? "Reviewing" : "Fixing"} 2/3`,
      );
      expect(reviewLabel({ ...state, phase, round: 2, waiting: true })).toContain(
        "Waiting for slot",
      );
    }
    expect(reviewLabel({ ...state, phase: "clean" })).toBe("Review clean");
    expect(reviewLabel({ ...state, phase: "escalated", reason: "worktree changed" })).toBe(
      "Escalated: worktree changed",
    );
    expect(reviewLabel({ ...state, phase: "escalated" })).toBe("Escalated: stopped");
  });
  it("validates bounded saved metadata and never automatically restarts a loop participant", () => {
    expect(isReviewState(state)).toBe(true);
    expect(
      isReviewState({ ...state, phase: "escalated", reason: "restored", waiting: false }),
    ).toBe(true);
    for (const value of [
      null,
      [],
      { ...state, authorId: "../x" },
      { ...state, rounds: 6 },
      { ...state, round: -1 },
      { ...state, round: 4 },
      { ...state, postFindings: 1 },
      { ...state, phase: "evil" },
      { ...state, reason: "arbitrary" },
      { ...state, phase: "escalated" },
      { ...state, waiting: 1 },
      { ...state, extra: true },
    ])
      expect(isReviewState(value)).toBe(false);
    const saved = {
      id: "child",
      agent: "claude",
      repository: "/repo",
      worktree: "/repo/child",
      branch: "child",
      parentId: "parent",
      running: true,
      conversationId: "conversation",
      review: state,
    };
    const restored = readSessions([saved]);
    expect(restored[0]?.review).toMatchObject({
      phase: "escalated",
      reason: "restored",
      waiting: false,
    });
    expect(restorePlan(restored, true)).toEqual([]);
    expect(readSessions([{ ...saved, parentId: undefined }])[0]?.review?.reason).toBe("restored");
    expect(() => readSessions([{ ...saved, review: { ...state, rounds: 9 } }])).toThrow(
      "Invalid review",
    );
  });
});
