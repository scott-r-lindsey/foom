import { expect, test, vi } from "vitest";
import { SessionLifecycle } from "../../../../src/main/workspace/session-lifecycle";

function setup() {
  const pending = Promise.withResolvers<undefined>();
  const deps = {
    release: vi.fn(),
    observed: vi.fn(),
    evaluate: vi.fn(() => pending.promise),
    inventorySettled: vi.fn(),
  };
  const lifecycle = new SessionLifecycle(deps);
  return { lifecycle, deps, pending };
}

test.each(["exit-first", "release-first"] as const)(
  "%s releases each invocation once and revokes authority before evaluation",
  async (order) => {
    const { lifecycle, deps, pending } = setup();
    deps.observed.mockImplementation(() => {
      expect(deps.release).toHaveBeenCalledExactlyOnceWith("t1");
      expect(deps.evaluate).not.toHaveBeenCalled();
    });
    if (order === "release-first") lifecycle.release("t1");
    const evaluation = lifecycle.exited("t1", 7);
    const observed = lifecycle.exit("t1");
    expect(observed).toEqual({ phase: "host-observed", code: 7 });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(deps.observed).toHaveBeenCalledExactlyOnceWith("t1");
    expect(deps.evaluate).toHaveBeenCalledExactlyOnceWith("t1", 7);
    lifecycle.release("t1");
    lifecycle.inventorySettled("t1");
    lifecycle.inventorySettled("t1");
    expect(deps.inventorySettled).toHaveBeenCalledExactlyOnceWith("t1");
    expect(lifecycle.exit("t1")).toEqual({ phase: "inventory-settled", code: 7 });
    expect(observed?.phase).toBe("host-observed");
    pending.resolve(undefined);
    await evaluation;
    expect(lifecycle.exit("t1")).toEqual({ phase: "evaluation-settled", code: 7 });
    lifecycle.removed("t1");
    lifecycle.removed("t1");
    expect(deps.release).toHaveBeenCalledTimes(1);
    expect(deps.observed).toHaveBeenCalledTimes(1);
  },
);

test("duplicate exits preserve the first code and pending evaluation", async () => {
  const { lifecycle, deps, pending } = setup();
  const first = lifecycle.exited("t1", 0);
  expect(lifecycle.exited("t1", 9)).toBe(first);
  lifecycle.inventorySettled("t1");
  pending.resolve(undefined);
  await first;
  await lifecycle.exited("t1", 9);
  expect(lifecycle.exit("t1")).toEqual({ phase: "evaluation-settled", code: 0 });
  expect(deps.evaluate).toHaveBeenCalledTimes(1);
});

test.each(["reset", "removed"] as const)(
  "%s prevents old evaluation completion from settling a removed or resumed invocation",
  async (change) => {
    const { lifecycle, deps, pending } = setup();
    const first = lifecycle.exited("t1", 2);
    lifecycle.inventorySettled("t1");
    lifecycle[change]("t1");
    if (change === "reset") {
      // The same ID now belongs to a new invocation with its own exit facts/resources.
      deps.evaluate.mockReturnValueOnce(new Promise(() => undefined));
      void lifecycle.exited("t1", 0);
    }
    pending.resolve(undefined);
    await first;
    expect(lifecycle.exit("t1")?.phase).toBe(
      change === "reset" ? "host-observed" : "inventory-settled",
    );
    lifecycle.inventorySettled("unknown");
    if (change === "removed") lifecycle.inventorySettled("t1");
    expect(deps.inventorySettled).toHaveBeenCalledTimes(1);
  },
);

test("removal before exit revokes authority once without evaluating a discarded screen", async () => {
  const { lifecycle, deps } = setup();
  lifecycle.removed("t1");
  await lifecycle.exited("t1", 9);
  lifecycle.inventorySettled("t1");
  expect(lifecycle.exit("t1")).toBeUndefined();
  expect(deps.release).toHaveBeenCalledExactlyOnceWith("t1");
  expect(deps.observed).toHaveBeenCalledExactlyOnceWith("t1");
  expect(deps.evaluate).not.toHaveBeenCalled();
  expect(deps.inventorySettled).not.toHaveBeenCalled();
});

test("skipped queued evaluation does not claim inventory or evaluation settled", async () => {
  const { lifecycle, pending } = setup();
  const evaluation = lifecycle.exited("early", 1);
  pending.resolve(undefined);
  await evaluation;
  expect(lifecycle.exit("early")).toEqual({ phase: "host-observed", code: 1 });
});
