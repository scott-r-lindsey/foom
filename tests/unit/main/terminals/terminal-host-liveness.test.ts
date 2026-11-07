import type * as PerfHooks from "node:perf_hooks";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, type MockInstance, test, vi } from "vitest";
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

test("an unresponsive host is retired after five seconds and a message-drain turn", async () => {
  const fail = vi.fn();
  cancel = watchHostLiveness(fail);
  await vi.advanceTimersByTimeAsync(4999);
  expect(fail).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4);
  expect(fail).toHaveBeenCalledOnce();
});
test("CPU measurements cannot extend the deadline", async () => {
  const cpu = vi
    .spyOn(process, "threadCpuUsage")
    .mockImplementation(() => ({ user: Date.now() * 1000, system: 0 }));
  const fail = vi.fn();
  cancel = watchHostLiveness(fail);
  await vi.advanceTimersByTimeAsync(5003);
  expect(fail).toHaveBeenCalledOnce();
  expect(cpu).not.toHaveBeenCalled();
});
test("a pause before the final drain grants grace only within the absolute cap", async () => {
  const immediate = vi.spyOn(globalThis, "setImmediate");
  const fail = vi.fn();
  cancel = watchHostLiveness(fail);
  await vi.advanceTimersByTimeAsync(5001);
  const callback = immediate.mock.calls.at(-1)?.[0];
  if (typeof callback !== "function") throw new Error("Missing drain callback");
  vi.clearAllTimers();
  vi.setSystemTime(11000);
  callback();
  await vi.advanceTimersByTimeAsync(3999);
  expect(fail).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4);
  expect(fail).toHaveBeenCalledOnce();
});
test("a matching pong cancels even a queued retirement turn", async () => {
  const immediate = vi.spyOn(globalThis, "setImmediate");
  const fail = vi.fn();
  cancel = watchHostLiveness(fail);
  await vi.advanceTimersByTimeAsync(5001);
  const callback = immediate.mock.calls.at(-1)?.[0];
  if (typeof callback !== "function") throw new Error("Missing drain callback");
  cancel();
  callback();
  await vi.advanceTimersByTimeAsync(6000);
  expect(fail).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("native lag measurements cannot renew the response window", async () => {
  const fail = vi.fn();
  cancel = watchHostLiveness(fail);
  delay.count = 1;
  delay.mean = 80e6; // 70 ms over the native monitor's 10 ms period.
  await vi.advanceTimersByTimeAsync(4999);
  expect(fail).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4);
  expect(fail).toHaveBeenCalledOnce();
});

async function fireMissedTurn(timers: MockInstance<typeof setTimeout>, now: number): Promise<void> {
  const callback = timers.mock.calls.at(-1)?.[0];
  if (typeof callback !== "function") throw new Error("Missing watchdog timer");
  vi.clearAllTimers();
  vi.setSystemTime(now);
  callback();
  await vi.advanceTimersByTimeAsync(2);
}

test("repeated missed turns cannot renew the probe beyond fifteen seconds", async () => {
  const timers = vi.spyOn(globalThis, "setTimeout");
  const failed = vi.fn();
  cancel = watchHostLiveness(failed);
  await fireMissedTurn(timers, 6000);
  await fireMissedTurn(timers, 12000);
  expect(failed).not.toHaveBeenCalled();
  await fireMissedTurn(timers, 15000);
  expect(failed).toHaveBeenCalledOnce();
  expect(Date.now()).toBe(15002);
});

test("overlapping CPU and lag cannot inflate the original response window", async () => {
  vi.spyOn(process, "threadCpuUsage").mockImplementation(() => ({
    user: Date.now() * 900,
    system: 0,
  }));
  const failed = vi.fn();
  cancel = watchHostLiveness(failed);
  for (let step = 0; step < 50; step++) {
    delay.count = 1;
    delay.mean = 100e6;
    await vi.advanceTimersByTimeAsync(100);
  }
  await vi.advanceTimersByTimeAsync(2);
  expect(failed).toHaveBeenCalledOnce();
});

test("the absolute limit holds with both overlap and repeated missed turns", async () => {
  const timers = vi.spyOn(globalThis, "setTimeout");
  vi.spyOn(process, "threadCpuUsage").mockImplementation(() => ({
    user: Date.now() * 900,
    system: 0,
  }));
  const failed = vi.fn();
  cancel = watchHostLiveness(failed);
  for (let step = 0; step < 40; step++) {
    delay.count = 1;
    delay.mean = 100e6;
    await vi.advanceTimersByTimeAsync(100);
  }
  await fireMissedTurn(timers, 6000);
  await fireMissedTurn(timers, 12000);
  await fireMissedTurn(timers, 15000);
  expect(failed).toHaveBeenCalledOnce();
});

test("a pong queued across the hard cap drains before any kill", async () => {
  const timers = vi.spyOn(globalThis, "setTimeout");
  const failed = vi.fn();
  cancel = watchHostLiveness(failed);
  const callback = timers.mock.calls.at(-1)?.[0];
  if (typeof callback !== "function") throw new Error("Missing deadline");
  vi.clearAllTimers();
  vi.setSystemTime(20000);
  callback();
  const drain = timers.mock.calls.at(-1)?.[0];
  if (typeof drain !== "function") throw new Error("Missing receive turn");
  drain();
  cancel(); // The queued pong is dispatched on the receive turn.
  await vi.advanceTimersByTimeAsync(10);
  expect(failed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("a silent host is retired on the first drain after main resumes beyond the cap", async () => {
  const timers = vi.spyOn(globalThis, "setTimeout");
  const failed = vi.fn();
  cancel = watchHostLiveness(failed);
  await fireMissedTurn(timers, 20000);
  expect(failed).toHaveBeenCalledOnce();
  expect(Date.now()).toBe(20002);
});
