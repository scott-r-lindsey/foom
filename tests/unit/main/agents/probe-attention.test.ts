import { afterEach, expect, test, vi } from "vitest";
import { ProbeAttention, PROBE_WAITING_MS } from "../../../../src/main/agents/probe-attention";
afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  let now = 100;
  const changed = vi.fn();
  const attention = new ProbeAttention(changed, PROBE_WAITING_MS, () => now);
  attention.add("probe", "owner");
  return {
    attention,
    changed,
    advance: async (ms: number) => {
      now += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}
test("only a continuously blocked probe reminds its own driver after sixty seconds", async () => {
  const f = fixture();
  f.attention.observe("missing", true);
  f.attention.input("missing");
  f.attention.observe("probe", false);
  await f.advance(PROBE_WAITING_MS);
  expect(f.changed).not.toHaveBeenCalled();
  f.attention.observe("probe", true);
  await f.advance(PROBE_WAITING_MS - 1);
  f.attention.observe("probe", true); // Repeated output/classification cannot postpone help.
  expect(f.attention.waitingAt("owner")).toBeUndefined();
  await f.advance(1);
  expect(f.attention.waitingAt("owner")).toBe(120100);
  expect(f.attention.waitingAt("foreign")).toBeUndefined();
  f.attention.input("probe");
  expect(f.attention.waitingAt("owner")).toBeUndefined();
  expect(f.changed).toHaveBeenCalledTimes(2);
});
test("input restarts the budget; resume and stop cancel it, including an overdue reminder", async () => {
  const f = fixture();
  f.attention.observe("probe", true);
  await f.advance(30000);
  f.attention.input("probe");
  await f.advance(PROBE_WAITING_MS);
  expect(f.attention.waitingAt("owner")).toBeUndefined();
  f.attention.observe("probe", true);
  await f.advance(30000);
  f.attention.observe("probe", false);
  await f.advance(PROBE_WAITING_MS);
  expect(f.attention.waitingAt("owner")).toBeUndefined();
  f.attention.observe("probe", true);
  await f.advance(PROBE_WAITING_MS);
  expect(f.attention.waitingAt("owner")).toBeDefined();
  f.attention.observe("probe", false);
  expect(f.attention.waitingAt("owner")).toBeUndefined();
  f.attention.observe("probe", true);
  f.attention.remove("probe");
  await f.advance(PROBE_WAITING_MS);
  expect(f.attention.waitingAt("owner")).toBeUndefined();
});
test("dismissal settles that blocked episode without affecting other drivers", async () => {
  const f = fixture();
  f.attention.add("second", "other");
  f.attention.observe("probe", true);
  f.attention.observe("second", true);
  f.attention.dismiss("foreign");
  await f.advance(PROBE_WAITING_MS);
  f.attention.dismiss("owner");
  expect(f.attention.waitingAt("owner")).toBeUndefined();
  expect(f.attention.waitingAt("other")).toBeDefined();
  f.attention.observe("probe", true);
  await f.advance(PROBE_WAITING_MS);
  expect(f.attention.waitingAt("owner")).toBeUndefined();
  f.attention.input("probe");
  f.attention.observe("probe", true);
  f.attention.dismiss("owner"); // Also cancels a pending timer.
  await f.advance(PROBE_WAITING_MS);
  expect(f.attention.waitingAt("owner")).toBeUndefined();
  f.attention.remove("probe");
  f.attention.remove("second");
});
