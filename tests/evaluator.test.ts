import { describe, expect, it } from "vitest";
import { evaluateRules } from "../src/evaluator";
import { evaluatorFixtures } from "./fixtures/evaluator";

const permission = {
  terminalId: "t1",
  action: "needs_input",
  signal: "claude:PermissionRequest",
} as const;
describe("rules evaluator", () => {
  it.each(evaluatorFixtures)("$name", ({ tail, state }) => {
    const result = evaluateRules({ terminalId: "t1", tail });
    expect(result.state).toBe(state);
    expect(result.reason).not.toContain("\n");
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
  it("uses terminal-scoped attention hooks ahead of live process facts and text", () => {
    expect(
      evaluateRules({
        terminalId: "t1",
        tail: ["FAIL test"],
        hook: permission,
        promptReturned: true,
      }),
    ).toMatchObject({ state: "needs_input", signal: permission.signal });
    expect(evaluateRules({ terminalId: "other", tail: [], hook: permission }).state).toBe(
      "working",
    );
  });
  it("keeps exit final even when a delayed permission arrives", () => {
    for (const [exitCode, state] of [
      [0, "done"],
      [1, "failed"],
      [-1, "failed"],
    ] as const) {
      expect(
        evaluateRules({ terminalId: "t1", tail: ["Password:"], hook: permission, exitCode }),
      ).toMatchObject({ state, signal: "process:exit" });
    }
  });
  it("does not treat invalid exit facts or completion notifications as Done", () => {
    for (const exitCode of [NaN, Infinity, 0.5]) {
      expect(evaluateRules({ terminalId: "t1", tail: [], exitCode }).state).toBe("working");
    }
    for (const signal of [
      "claude:Stop",
      "claude:idle_prompt",
      "codex:agent-turn-complete",
    ] as const) {
      expect(
        evaluateRules({
          terminalId: "t1",
          tail: [],
          hook: { terminalId: "t1", action: "classify", signal },
        }).state,
      ).toBe("working");
      expect(
        evaluateRules({
          terminalId: "t1",
          tail: ["Password:"],
          hook: { terminalId: "t1", action: "classify", signal },
        }).state,
      ).toBe("needs_input");
    }
  });
  it("accepts an observed prompt return, not a guessed shell glyph", () => {
    expect(
      evaluateRules({ terminalId: "t1", tail: ["Password:"], promptReturned: true }),
    ).toMatchObject({ state: "done", signal: "process:prompt" });
  });
});
