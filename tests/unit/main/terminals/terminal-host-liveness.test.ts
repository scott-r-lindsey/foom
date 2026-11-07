import type * as PerfHooks from "node:perf_hooks";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { watchHostLiveness } from "../../../../src/main/terminals/terminal-host-liveness";
const delay = vi.hoisted(() => ({
  count: 0,
  mean: 0,
  enable: vi.fn(),
  disable: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("node:perf_hooks", async (original) => ({
  ...(await original<typeof PerfHooks>()),
  monitorEventLoopDelay: () => delay,
}));
let cancel = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.spyOn(process, "threadCpuUsage").mockReturnValue({ user: 0, system: 0 });
  delay.count = 0;
  delay.mean = 0;
  delay.reset.mockImplementation(() => {
    delay.count = 0;
    delay.mean = 0;
  });
});
afterEach(() => {
  cancel();
  vi.useRealTimers();
});

test("an unresponsive host is retired after five seconds of main event-loop wait time", async () => {
  const fail = vi.fn();
  cancel = watchHostLiveness(fail);
  await vi.advanceTimersByTimeAsync(4999);
  expect(fail).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2);
  expect(fail).toHaveBeenCalledOnce();
});
test("main's active work cannot consume the host's receive window", async () => {
  vi.spyOn(process, "threadCpuUsage").mockImplementation(() => ({
    user: Math.min(Date.now(), 5000) * 1000,
    system: 0,
  }));
  const fail = vi.fn();
  cancel = watchHostLiveness(fail);
  await vi.advanceTimersByTimeAsync(9999);
  expect(fail).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2);
  expect(fail).toHaveBeenCalledOnce();
});
test("a pause between the timer and final message-drain turn restarts the whole window", async () => {
  const immediate = vi.spyOn(globalThis, "setImmediate");
  const fail = vi.fn();
  cancel = watchHostLiveness(fail);
  await vi.advanceTimersByTimeAsync(5000);
  const callback = immediate.mock.calls.at(-1)?.[0];
  if (typeof callback !== "function") throw new Error("Missing drain callback");
  vi.clearAllTimers();
  vi.setSystemTime(11000);
  callback();
  await vi.advanceTimersByTimeAsync(4999);
  expect(fail).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2);
  expect(fail).toHaveBeenCalledOnce();
});
test("a matching pong cancels even a queued retirement turn", async () => {
  const immediate = vi.spyOn(globalThis, "setImmediate");
  const fail = vi.fn();
  cancel = watchHostLiveness(fail);
  await vi.advanceTimersByTimeAsync(5000);
  const callback = immediate.mock.calls.at(-1)?.[0];
  if (typeof callback !== "function") throw new Error("Missing drain callback");
  cancel();
  callback();
  await vi.advanceTimersByTimeAsync(6000);
  expect(fail).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("native loop delays discount blocking waits that use no CPU", async () => {
  const fail = vi.fn();
  cancel = watchHostLiveness(fail);
  delay.count = 1;
  delay.mean = 80e6; // 70 ms over the native monitor's 10 ms period.
  await vi.advanceTimersByTimeAsync(5099);
  expect(fail).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2);
  expect(fail).toHaveBeenCalledOnce();
});
