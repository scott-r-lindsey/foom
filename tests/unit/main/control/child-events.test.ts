import { afterEach, expect, it, vi } from "vitest";
import { ChildEvents } from "../../../../src/main/control/child-events";

afterEach(() => vi.useRealTimers());

it("coalesces invalidations, supports multiple consumers and releases subscriptions", async () => {
  const events = new ChildEvents();
  events.publish();
  const first = vi.fn();
  const second = vi.fn();
  const off = events.subscribe(first);
  const offSecond = events.subscribe(second);
  events.publish();
  events.publish();
  await Promise.resolve();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  off();
  events.publish();
  offSecond();
  await Promise.resolve();
  expect(second).toHaveBeenCalledTimes(1);
});

it("shares one deadline timer and releases it when the final deadline subscriber leaves", async () => {
  vi.useFakeTimers();
  const events = new ChildEvents();
  const idle = events.subscribe(vi.fn());
  expect(vi.getTimerCount()).toBe(0);
  const notify = vi.fn();
  const later = events.subscribe(notify, Date.now() + 2000);
  const earlier = events.subscribe(() => {
    earlier();
  }, Date.now() + 1000);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(notify).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  later();
  expect(vi.getTimerCount()).toBe(0);
  idle();
});

it("delivers a deadline once even when a consumer remains subscribed", async () => {
  vi.useFakeTimers();
  const events = new ChildEvents();
  const notify = vi.fn();
  const off = events.subscribe(notify, Date.now());
  await vi.advanceTimersByTimeAsync(1);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  off();
});
