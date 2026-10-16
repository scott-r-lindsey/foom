import { expect, it } from "vitest";
import { waitingState } from "../../../../src/main/workspace/waiting-state";
import type { ExecutionSnapshot } from "../../../../src/shared/execution";
import type { TerminalState } from "../../../../src/shared/workspace";

const execution: ExecutionSnapshot = {
  terminalId: "parent",
  launch: 1,
  revision: 2,
  turn: 1,
  phase: "idle",
};
const state: TerminalState = {
  id: "parent",
  execution,
  verdictId: "verdict",
  state: "done",
  reason: "Done",
  signal: "hook:stop",
  confidence: 1,
  timestamp: 10,
};
it("presents idle parents with pending children as waiting without changing their verdict", () => {
  expect(waitingState("parent", state, execution, 2)).toEqual({ ...state, waitingOn: 2 });
  expect(waitingState("parent", state, execution, 0)).toBe(state);
  expect(state).not.toHaveProperty("waitingOn");
  expect(
    waitingState(
      "parent",
      { ...state, state: "needs_input", attentionKind: "unknown" },
      execution,
      1,
    )?.waitingOn,
  ).toBe(1);
});
it.each(["question", "permission", "credential", "provider", undefined] as const)(
  "keeps %s attention visible while children run",
  (attentionKind) => {
    const prompt: TerminalState = {
      ...state,
      state: "needs_input",
      ...(attentionKind ? { attentionKind } : {}),
    };
    expect(waitingState("parent", prompt, execution, 1)).toBe(prompt);
  },
);
it("keeps failures and non-idle execution visible", () => {
  const failed: TerminalState = { ...state, state: "failed" };
  expect(waitingState("parent", failed, execution, 1)).toBe(failed);
  for (const phase of ["starting", "working", "blocked", "exited"] as const)
    expect(waitingState("parent", state, { ...execution, phase }, 1)).toBe(state);
  expect(waitingState("parent", null, undefined, 1)).toBeNull();
});
it("uses current idle evidence while asynchronous classification is pending", () => {
  for (const prior of [
    null,
    { ...state, execution: { ...execution, revision: 1 } },
    { ...state, execution: { ...execution, launch: 0 } },
  ]) {
    expect(waitingState("parent", prior, execution, 1)).toMatchObject({
      state: "quiet_ok",
      execution,
      waitingOn: 1,
      verdictId: null,
    });
    expect(waitingState("parent", prior, execution, 0)).toBe(prior);
  }
});
