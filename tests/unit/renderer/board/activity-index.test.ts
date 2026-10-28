// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { activityRows, subscribeActivity } from "../../../../src/renderer/board/activity-index";
import type { TerminalActivity } from "../../../../src/shared/desktop";
import { subscribeLights } from "../../../../src/renderer/board/light-activity";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import { boardRows } from "../../../fixtures/board";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("tile lights ignore activity for other sessions and share one source subscription", () => {
  vi.useFakeTimers();
  const rows = boardRows(0).map((row) => ({ ...row, rate: 0 }));
  const row = rows[0];
  const other = rows[1];
  if (!row || !other) throw new Error("Missing fixtures");
  const source = createSampleSource(rows);
  const subscribe = vi.spyOn(source, "subscribeActivity");
  const target = vi.fn(() => [{ row, element: document.createElement("span") }]);
  const stop = subscribeLights(source, target, undefined, row.id);
  const stopOther = subscribeLights(source, () => [], undefined, other.id);
  expect(subscribe).toHaveBeenCalledTimes(1);
  target.mockClear();
  source.setActivity(other.id, 4000);
  vi.advanceTimersByTime(50);
  expect(target).not.toHaveBeenCalled();
  stop();
  stopOther();
  expect(vi.getTimerCount()).toBe(0);
});

test("indexes each immutable snapshot once across owners and activity ticks", () => {
  vi.useFakeTimers();
  const fixture = boardRows(0)[0];
  if (!fixture) throw new Error("Missing fixture");
  const readId = vi.fn((i: number) => `session-${String(i)}`);
  const rows = Array.from({ length: 100 }, (_, i) => ({
    ...fixture,
    rate: 0,
    get id() {
      return readId(i);
    },
  }));
  const source = createSampleSource(rows);
  const first = activityRows(source);
  expect(first.size).toBe(100);
  expect(first.get("missing")).toBeUndefined();
  expect(readId).toHaveBeenCalledTimes(100);
  expect(activityRows(source)).toBe(first);
  const stops = Array.from({ length: 8 }, (_, i) =>
    subscribeLights(source, () => [], undefined, `session-${String(i)}`),
  );
  source.setActivity("session-1", 4000);
  vi.advanceTimersByTime(1000);
  expect(readId).toHaveBeenCalledTimes(100);
  source.update("session-1", { launchVersion: 1 });
  const second = activityRows(source);
  expect(second).not.toBe(first);
  expect(second.get("session-1")?.launchVersion).toBe(1);
  expect(activityRows(source)).toBe(second);
  for (const stop of stops) stop();
});

test("dispatches batches once, replays current rates, prunes stale launches, and releases ownership", () => {
  const fixture = boardRows(0)[0];
  if (!fixture) throw new Error("Missing fixture");
  const a = { ...fixture, id: "a", rate: 0 };
  const b = { ...fixture, id: "b", rate: 0 };
  let rows = [a, b];
  const sample = createSampleSource(rows);
  let emit: (batch: readonly TerminalActivity[]) => void = () => {};
  const offActivity = vi.fn();
  const offRows = vi.fn();
  const source = {
    ...sample,
    getSnapshot: () => rows,
    subscribe: (listener: () => void) => {
      const stop = sample.subscribe(listener);
      return () => {
        stop();
        offRows();
      };
    },
    subscribeActivity: vi.fn((listener: (batch: readonly TerminalActivity[]) => void) => {
      emit = listener;
      listener([{ id: "a", rate: 100 }]);
      return offActivity;
    }),
  };
  const all = vi.fn();
  const scoped = vi.fn();
  const stop = subscribeActivity(source, all);
  const stopA = subscribeActivity(source, scoped, "a");
  expect(scoped).toHaveBeenLastCalledWith([{ id: "a", rate: 100 }]);
  const extra = vi.fn();
  const stopExtra = subscribeActivity(source, extra, "a");
  const stopMissing = subscribeActivity(source, vi.fn(), "missing");
  const batch = [
    { id: "a", rate: 200 },
    { id: "b", rate: 300 },
    { id: "missing", rate: 10 },
  ];
  all.mockClear();
  scoped.mockClear();
  emit(batch);
  expect(all).toHaveBeenCalledExactlyOnceWith(batch);
  expect(scoped).toHaveBeenCalledExactlyOnceWith([batch[0]]);
  expect(extra).toHaveBeenLastCalledWith([batch[0]]);
  const replay = vi.fn();
  const stopReplay = subscribeActivity(source, replay);
  expect(replay).toHaveBeenCalledExactlyOnceWith([
    { id: "a", rate: 200 },
    { id: "b", rate: 300 },
  ]);
  rows = [
    { ...a, launchVersion: 1 },
    { ...b, exited: true },
  ];
  sample.update("a", {});
  const stale = vi.fn();
  const stopStale = subscribeActivity(source, stale);
  expect(stale).not.toHaveBeenCalled();
  emit([
    { id: "b", rate: 500 },
    { id: "a", rate: 10 },
  ]);
  rows = [];
  sample.update("a", {});
  stopA();
  stopExtra();
  stopMissing();
  stopReplay();
  stopStale();
  expect(offActivity).not.toHaveBeenCalled();
  stop();
  expect(offActivity).toHaveBeenCalledTimes(1);
  expect(offRows).toHaveBeenCalledTimes(1);
  const again = subscribeActivity(source, vi.fn(), "a");
  expect(source.subscribeActivity).toHaveBeenCalledTimes(2);
  again();
});
