import { afterEach, expect, it, vi } from "vitest";
import { ModelEvaluator } from "../../../../src/main/evaluator/model-evaluator";
import { evaluateRules } from "../../../../src/main/evaluator/evaluator";
import { evaluatorFixtures } from "../../../fixtures/evaluator";
const answer = '{"state":"needs_input","confidence":0.9}';
afterEach(() => vi.useRealTimers());

it("uses rules first and calls the source only for ambiguous tails", async () => {
  const complete = vi.fn().mockResolvedValue(answer);
  const model = new ModelEvaluator({ complete });
  for (const fixture of evaluatorFixtures) {
    const input = { terminalId: "t1", tail: fixture.tail };
    const rules = evaluateRules(input);
    const verdict = await model.evaluate(input);
    expect(verdict).toEqual(
      rules.signal === "rules:ambiguous"
        ? expect.objectContaining({ signal: "model:classification" })
        : rules,
    );
  }
  expect(complete).toHaveBeenCalled();
  complete.mockClear();
  expect(await model.evaluate({ terminalId: "t1", tail: [], exitCode: 0 })).toMatchObject({
    state: "done",
  });
  expect(complete).not.toHaveBeenCalled();
});
it("supports rules-only setup and reports actual model results with a timed sample check", async () => {
  expect(await new ModelEvaluator().runCheck()).toMatchObject({
    status: "rules",
    verdict: { state: "working" },
  });
  const complete = vi.fn().mockResolvedValue(answer);
  const check = await new ModelEvaluator({ complete }).runCheck(["Password:"]);
  expect(check).toMatchObject({ status: "model", verdict: { state: "needs_input" } });
  expect(check.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(complete).toHaveBeenCalledTimes(1);
});
it("exposes only redacted tail input, without terminal identity, hooks, files, or facts", async () => {
  const complete = vi.fn().mockResolvedValue(answer);
  await new ModelEvaluator({ complete }).evaluate({
    terminalId: "private-id",
    tail: ["OPENAI_API_KEY=private-value", "Working..."],
    hook: { terminalId: "private-id", action: "classify", signal: "claude:Stop" },
  });
  const prompt: unknown = complete.mock.calls[0]?.[0];
  expect(prompt).not.toContain("private-id");
  expect(prompt).not.toContain("private-value");
  expect(prompt).not.toContain("claude:Stop");
});
it("falls back on transport, malformed, oversized input, and synchronous failures", async () => {
  const complete = vi
    .fn()
    .mockRejectedValueOnce(new Error("private error"))
    .mockResolvedValueOnce("hostile output")
    .mockImplementationOnce(() => {
      throw new Error("sync");
    })
    .mockResolvedValue(answer);
  const model = new ModelEvaluator({ complete }, 100, 1);
  for (let i = 0; i < 3; i++)
    expect(await model.runCheck()).toMatchObject({
      status: "failed",
      verdict: { signal: "rules:ambiguous" },
    });
  expect(await model.runCheck(["x".repeat(131073)])).toMatchObject({ status: "failed" });
  expect(await model.runCheck()).toMatchObject({ status: "model" });
});
it("bounds concurrent calls including transports that ignore cancellation", async () => {
  vi.useFakeTimers();
  let finish: (text: string) => void = () => {
    throw new Error("not started");
  };
  let signal: AbortSignal | undefined;
  const complete = vi.fn((_prompt: string, abort: AbortSignal) => {
    signal = abort;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  const model = new ModelEvaluator({ complete }, 100, 1);
  const pending = model.runCheck();
  expect(await model.runCheck()).toMatchObject({ status: "busy" });
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toMatchObject({ status: "timeout", verdict: { state: "working" } });
  expect(signal?.aborted).toBe(true);
  expect(await model.runCheck()).toMatchObject({ status: "busy" });
  finish(answer);
  await Promise.resolve();
  const next = model.runCheck();
  finish(answer);
  expect(await next).toMatchObject({ status: "model" });
  expect(vi.getTimerCount()).toBe(0);
});
it("handles abort rejection and late errors without unhandled rejections", async () => {
  vi.useFakeTimers();
  const complete = vi.fn(
    (_prompt: string, signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      }),
  );
  const model = new ModelEvaluator({ complete }, 10);
  const pending = model.runCheck();
  await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toMatchObject({ status: "timeout" });
});
it.each([
  [0, 1],
  [30001, 1],
  [NaN, 1],
  [1, 0],
  [1, 5],
  [1, 1.5],
])("rejects invalid limits %s, %s", (timeout, concurrency) => {
  expect(() => new ModelEvaluator(undefined, timeout, concurrency)).toThrow();
});
