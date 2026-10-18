import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChildEvents } from "../../../../src/main/control/child-events";
import type { ChildObservation } from "../../../../src/main/control/child-events";

let events: ChildEvents;
let changed: ReturnType<typeof vi.fn<() => void>>;
const child = (patch: Partial<ChildObservation> = {}): ChildObservation => ({
  id: "child",
  parentId: "parent",
  exited: false,
  ...patch,
});
const execution = (phase: "working" | "idle", turn = 1) => ({
  terminalId: "child",
  launch: 1,
  revision: turn,
  phase,
  turn,
});
const pr = {
  number: 1,
  headSha: "a".repeat(40),
  state: "OPEN" as const,
  requiredChecks: "pending" as const,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  changed = vi.fn();
  events = new ChildEvents(changed);
});
afterEach(() => {
  events.dispose();
  vi.useRealTimers();
});

it("alerts exactly at five minutes, keeps the oldest event and schedules later children", () => {
  events.sync([child({ handoff: { seq: 1, status: "done" } })]);
  vi.advanceTimersByTime(60000);
  events.sync([
    child({ handoff: { seq: 2, status: "blocked" } }),
    child({ id: "second", exited: true }),
  ]);
  vi.advanceTimersByTime(239999);
  expect(events.overdue("parent")).toBeUndefined();
  expect(changed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(events.overdue("parent")).toBe(1000);
  expect(changed).toHaveBeenCalledOnce();
  expect(events.read("parent", "child")).toBe(true);
  expect(events.overdue("parent")).toBeUndefined();
  vi.advanceTimersByTime(60000);
  expect(events.overdue("parent")).toBe(61000);
  expect(changed).toHaveBeenCalledTimes(2);
});

it("acknowledges only the specified parent's children and does not re-alert on unchanged observations", () => {
  const rows = [
    child({ exited: true }),
    child({ id: "other", parentId: "elsewhere", exited: true }),
  ];
  events.sync(rows);
  expect(events.read("stranger")).toBe(false);
  expect(events.read("parent", "missing")).toBe(false);
  expect(events.read("parent")).toBe(true);
  events.sync(rows);
  vi.advanceTimersByTime(300000);
  expect(events.overdue("parent")).toBeUndefined();
  expect(events.overdue("elsewhere")).toBe(1000);
  expect(events.read("elsewhere", "other")).toBe(true);
  expect(events.read("elsewhere", "other")).toBe(false);
  expect(events.overdue("elsewhere")).toBeUndefined();
});

it("can turn reminders off, change the threshold, remove children and reset ownership", () => {
  events.configure(0);
  events.sync([child({ exited: true })]);
  vi.advanceTimersByTime(300000);
  expect(events.overdue("parent")).toBeUndefined();
  events.configure(1);
  expect(events.overdue("parent")).toBe(1000);
  events.configure(10);
  expect(events.overdue("parent")).toBeUndefined();
  events.sync([child({ parentId: "new", execution: execution("working") })]);
  vi.advanceTimersByTime(600000);
  expect(events.overdue("parent")).toBeUndefined();
  expect(events.overdue("new")).toBeUndefined();
  events.sync([child({ parentId: "new", exited: true })]);
  events.sync([]);
  vi.advanceTimersByTime(600000);
  expect(events.overdue("new")).toBeUndefined();
});

it("observes idle and exit without a handoff, ignoring ordinary execution progress", () => {
  events.sync([child({ execution: execution("working") })]);
  vi.advanceTimersByTime(300000);
  expect(events.overdue("parent")).toBeUndefined();
  const idle = child({ execution: execution("idle") });
  events.sync([idle]);
  events.read("parent");
  events.sync([idle]);
  vi.advanceTimersByTime(300000);
  expect(events.overdue("parent")).toBeUndefined();
  events.sync([child({ execution: execution("working", 2) })]);
  events.sync([child({ execution: execution("idle", 2) })]);
  vi.advanceTimersByTime(300000);
  expect(events.overdue("parent")).toBe(601000);
  events.read("parent");
  events.sync([child({ execution: execution("idle", 2), exited: true })]);
  vi.advanceTimersByTime(300000);
  expect(events.overdue("parent")).toBe(901000);
});

it("does not create a duplicate idle/exit event after a report for the same turn", () => {
  const handoff = { seq: 1, status: "done" as const };
  events.sync([child({ execution: execution("working"), handoff })]);
  events.read("parent");
  events.sync([child({ execution: execution("idle"), handoff, exited: true })]);
  vi.advanceTimersByTime(300000);
  expect(events.overdue("parent")).toBeUndefined();
  events.sync([child({ execution: execution("working", 2), handoff })]);
  events.sync([child({ execution: execution("idle", 2), handoff })]);
  vi.advanceTimersByTime(300000);
  expect(events.overdue("parent")).toBe(301000);
});

it("observes required-check changes and PR close/merge, ignoring head-only changes and unavailable observations", () => {
  events.sync([child({ pullRequest: pr })]);
  events.read("parent");
  events.sync([child({ pullRequest: { ...pr, headSha: "b".repeat(40) } })]);
  vi.advanceTimersByTime(300000);
  expect(events.overdue("parent")).toBeUndefined();
  for (const pullRequest of [
    { ...pr, requiredChecks: "success" as const },
    { ...pr, state: "CLOSED" as const },
    { ...pr, state: "MERGED" as const },
  ]) {
    events.sync([child({ pullRequest })]);
    vi.advanceTimersByTime(300000);
    expect(events.overdue("parent")).toBeDefined();
    events.read("parent");
  }
  events.sync([child()]);
  vi.advanceTimersByTime(300000);
  expect(events.overdue("parent")).toBeUndefined();
  events.sync([child({ pullRequest: { ...pr, state: "MERGED" } })]);
  vi.advanceTimersByTime(300000);
  expect(events.overdue("parent")).toBeUndefined();
});

it("cancels scheduled callbacks on disposal", () => {
  events.sync([child({ exited: true })]);
  events.dispose();
  vi.advanceTimersByTime(300000);
  expect(changed).not.toHaveBeenCalled();
  expect(events.overdue("parent")).toBeUndefined();
});
