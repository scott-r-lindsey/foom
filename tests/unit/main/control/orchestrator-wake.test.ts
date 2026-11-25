import { afterEach, expect, test, vi } from "vitest";
import { OrchestratorWake } from "../../../../src/main/control/orchestrator-wake";
import { Operations } from "../../../../src/main/control/operations";
import type { OrchestrationHost } from "../../../../src/main/control/orchestration.d";
import type { Principal, StoredOperation } from "../../../../src/main/control/types";
const actor: Principal = {
  terminalId: "p",
  generation: "g",
  repository: "r",
  worktree: "w",
  role: "orchestrator",
  sessionId: "s",
  parentId: null,
  grantedAt: "now",
};
const instances: OrchestratorWake[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
  vi.useRealTimers();
});
function setup(persist: () => Promise<void> = () => Promise.resolve()) {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const records: StoredOperation[] = [];
  const operations = new Operations(
    (row) => {
      records.push(row);
      return persist();
    },
    () => {},
  );
  const valid = vi.fn(() => true);
  const wake = vi.fn<NonNullable<OrchestrationHost["wake"]>>(async (_id, _line, valid, intent) => {
    if (!valid()) return "queued";
    await intent();
    return "sent";
  });
  const note = vi.fn();
  const instance = new OrchestratorWake({ wake, terminals: () => [] }, valid, note);
  instances.push(instance);
  instance.bind(actor, operations);
  return { instance, operations, valid, wake, note, records };
}
test("off by default; coalesces events and logs a single wake then enforces the configurable interval", async () => {
  const f = setup();
  f.instance.event("p", "a");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.wake).not.toHaveBeenCalled();
  f.instance.configure(true, 3);
  f.instance.event("p", "a");
  f.instance.event("p", "b");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.wake).toHaveBeenCalledOnce();
  expect(f.wake.mock.calls[0]?.[1]).toContain("child, child");
  expect(f.records.map((r) => r.operation.status)).toEqual(["running", "succeeded"]);
  f.instance.event("p", "b");
  await vi.advanceTimersByTimeAsync(179999);
  expect(f.wake).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2001);
  expect(f.wake).toHaveBeenCalledTimes(2);
});
test("queues uncertain readiness without logging, and retries later", async () => {
  const f = setup();
  f.instance.configure(true, 1);
  f.wake.mockResolvedValueOnce("queued");
  f.instance.event("p", "a");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.records).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.records.at(-1)?.operation.status).toBe("succeeded");
});
test("revocation, missing bindings, disabling, reads and disposal discard queued events", async () => {
  const f = setup();
  f.instance.configure(true, 1);
  f.instance.event("unknown", "a");
  f.valid.mockReturnValue(false);
  f.instance.event("p", "a");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.wake).not.toHaveBeenCalled();
  f.valid.mockReturnValue(true);
  f.instance.event("p", "a");
  f.instance.read("p", "a");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.wake).not.toHaveBeenCalled();
  f.instance.event("p", "a");
  f.instance.configure(false, 1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.wake).not.toHaveBeenCalled();
  f.instance.configure(true, 1);
  f.instance.event("p", "a");
  f.instance.dispose();
  f.instance.event("p", "b");
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.wake).not.toHaveBeenCalled();
});
test("a menu after intent queues delivery, records cancellation and rate limits subsequent attempts", async () => {
  const f = setup();
  f.instance.configure(true, 1);
  f.wake.mockImplementationOnce(async (_id, _line, _valid, intent) => {
    await intent();
    return "queued";
  });
  f.instance.event("p", "a");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.records.at(-1)?.operation.status).toBe("cancelled");
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.records.at(-1)?.operation.status).toBe("succeeded");
});
test("ambiguous delivery is logged and never retried, while pre-intent failure remains queued", async () => {
  const f = setup();
  f.instance.configure(true, 1);
  f.wake.mockRejectedValueOnce(new Error("screen unavailable"));
  f.instance.event("p", "a");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.records).toHaveLength(0);
  f.wake.mockImplementationOnce(async (_id, _line, _valid, intent) => {
    await intent();
    throw new Error("lost write ack");
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.records.at(-1)?.operation.status).toBe("indeterminate");
  await vi.advanceTimersByTimeAsync(120000);
  expect(f.wake).toHaveBeenCalledTimes(2);
});
test("a new event arriving during delivery survives the completed batch", async () => {
  const f = setup();
  f.instance.configure(true, 1);
  f.wake.mockImplementationOnce(async (_id, _line, _valid, intent) => {
    await intent();
    f.instance.event("p", "a");
    return "sent";
  });
  f.instance.event("p", "a");
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.wake).toHaveBeenCalledTimes(2);
});

test("delivery gates authority/hook/focus, checks the host, cancels, waits and rechecks before submit", async () => {
  const { deliverWake } = await import("../../../../src/main/control/orchestrator-wake");
  vi.useFakeTimers();
  const policy = {
    cancelKeys: ["esc" as const],
    composer: ["❯"],
    contains: [],
    reject: ["permission"],
  };
  const allowed = vi.fn(() => true);
  const write = vi.fn(async (_input: { step: string }) => {
    await Promise.resolve();
    return true;
  });
  const intent = vi.fn(() => Promise.resolve());
  expect(await deliverWake(undefined, write, allowed, "line", intent)).toBe("queued");
  expect(await deliverWake(policy, undefined, allowed, "line", intent)).toBe("queued");
  allowed.mockReturnValue(false);
  expect(await deliverWake(policy, write, allowed, "line", intent)).toBe("queued");
  allowed.mockReturnValue(true);
  write.mockResolvedValueOnce(false);
  expect(await deliverWake(policy, write, allowed, "line", intent)).toBe("queued");
  allowed.mockReturnValueOnce(true).mockReturnValueOnce(false);
  expect(await deliverWake(policy, write, allowed, "line", intent)).toBe("queued");
  intent.mockImplementationOnce(() => {
    allowed.mockReturnValue(false);
    return Promise.resolve();
  });
  expect(await deliverWake(policy, write, allowed, "line", intent)).toBe("queued");
  allowed.mockReturnValue(true);
  write.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await deliverWake(policy, write, allowed, "line", intent)).toBe("queued");
  write.mockClear();
  const pending = deliverWake(policy, write, allowed, "line", intent);
  await vi.advanceTimersByTimeAsync(149);
  expect(write.mock.calls.map(([input]) => input.step)).toEqual(["check", "cancel"]);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toBe("sent");
  expect(write.mock.calls.at(-1)?.[0].step).toBe("submit");
  const revoked = deliverWake(policy, write, allowed, "line", intent);
  await vi.advanceTimersByTimeAsync(0);
  allowed.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(150);
  expect(await revoked).toBe("queued");
  allowed.mockReturnValue(true);
  write.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  const menu = deliverWake(policy, write, allowed, "line", intent);
  await vi.advanceTimersByTimeAsync(150);
  expect(await menu).toBe("queued");
});

test("re-grant discards the old queue instead of replaying it under new authority", async () => {
  const f = setup();
  f.instance.configure(true, 1);
  f.instance.event("p", "a");
  f.instance.bind({ ...actor, generation: "new" }, f.operations);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.wake).not.toHaveBeenCalled();
});

test("grant revocation withdraws the automation binding even when credential generation is unchanged", async () => {
  const f = setup();
  f.instance.configure(true, 1);
  f.instance.event("p", "a");
  f.instance.bind({ ...actor, role: "agent" }, f.operations);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.wake).not.toHaveBeenCalled();
});

test("integrated authority logs owned child wakes and withdraws access on takeover or parent exit", async () => {
  const { harness } = await import("./orchestration-helpers");
  vi.useFakeTimers();
  const h = harness();
  try {
    const child = await h.child("feature");
    const wake = vi.fn<NonNullable<OrchestrationHost["wake"]>>(
      async (_id, _line, valid, intent) => {
        if (!valid()) return "queued";
        await intent();
        return "sent";
      },
    );
    Reflect.set(h.host, "wake", wake);
    h.orchestration.configureWake(true, 3);
    h.orchestration.handoffs.restore(child.id, [
      {
        seq: 1,
        status: "done",
        summary: "private",
        links: [],
        timestamp: new Date().toISOString(),
      },
    ]);
    h.orchestration.syncUnreadChildEvents();
    await vi.advanceTimersByTimeAsync(0);
    expect(wake).toHaveBeenCalledOnce();
    const view = h.orchestration.view("parent");
    if (view?.role !== "orchestrator") throw new Error("Missing parent view");
    expect(view.history).toContainEqual(
      expect.objectContaining({ action: "wake", status: "succeeded" }),
    );
    h.orchestration.handoffs.restore(child.id, [
      {
        seq: 2,
        status: "failed",
        summary: "private",
        links: [],
        timestamp: new Date().toISOString(),
      },
    ]);
    h.orchestration.syncUnreadChildEvents();
    h.orchestration.takeOver(child.id);
    h.advance(180000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(wake).toHaveBeenCalledOnce();
    h.exit("parent");
    await vi.advanceTimersByTimeAsync(2000);
    expect(wake).toHaveBeenCalledOnce();
  } finally {
    h.orchestration.disposeUnreadChildren();
  }
});

test("disable then re-enable during durable intent cannot revive the withdrawn queue", async () => {
  const intent = Promise.withResolvers<undefined>();
  let first = true;
  const f = setup(() => {
    if (first) {
      first = false;
      return intent.promise;
    }
    return Promise.resolve();
  });
  let current: (() => boolean) | undefined;
  f.wake.mockImplementationOnce(async (_id, _line, valid, begin) => {
    current = valid;
    await begin();
    return valid() ? "sent" : "queued";
  });
  f.instance.configure(true, 1);
  f.instance.event("p", "a");
  await vi.advanceTimersByTimeAsync(0);
  expect(current?.()).toBe(true);
  f.instance.configure(false, 1);
  f.instance.configure(true, 1);
  expect(current?.()).toBe(false);
  intent.resolve(undefined);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.records.at(-1)?.operation.status).toBe("cancelled");
  expect(f.wake).toHaveBeenCalledOnce();
});

test("coalesces structured answers with child events without including decision contents", async () => {
  const f = setup();
  f.instance.configure(true, 1);
  f.instance.boardEvent("p", "answer");
  f.instance.boardRead("p", ["answer"]);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.wake).not.toHaveBeenCalled();
  f.instance.boardEvent("p", "answer");
  f.instance.event("p", "child");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.wake.mock.calls[0]?.[1]).toBe(
    "Foom: child and board events. Call wait_for, read_handoff and board_read.",
  );
  f.instance.boardEvent("p", "answer");
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.wake.mock.calls.at(-1)?.[1]).toBe(
    "Foom: board decisions answered. Call wait_for and board_read.",
  );
});

test("keeps a board wake when the queue overflows even if individually tracked answers are read", async () => {
  const f = setup();
  f.instance.configure(true, 1);
  const posts = Array.from({ length: 65 }, (_, index) => String(index));
  for (const post of posts) f.instance.boardEvent("p", post);
  f.instance.boardRead("p", posts);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.wake.mock.calls[0]?.[1]).toContain("board decisions answered");
  expect(f.wake).toHaveBeenCalledOnce();
});
