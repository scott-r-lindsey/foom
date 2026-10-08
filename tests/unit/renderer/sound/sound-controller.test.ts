import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SetupState } from "../../../../src/shared/setup";
import type { BoardRow } from "../../../../src/renderer/board/board.d";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import {
  activityIntensity,
  createSoundController,
  REPEAT_MS,
} from "../../../../src/renderer/sound/sound-controller";
import { DEFAULT_SOUND } from "../../../../src/shared/sounds";
import { setupState } from "../../../fixtures/setup";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());
const row = (id: string): BoardRow => ({
  id,
  kind: "shell",
  repository: "repo",
  branch: "main",
  agent: "Shell",
  state: "working",
  reason: "",
  rate: 0,
  waitingSince: 0,
  seen: false,
  tail: [],
});
async function fixture(
  initial = Promise.resolve(setupState()),
  initialRows = [row("a"), row("b")],
) {
  let focus: string | undefined;
  let settingsChanged: ((state: SetupState) => void) | undefined;
  const source = createSampleSource(initialRows);
  const sink = {
    configure: vi.fn(),
    working: vi.fn(),
    alert: vi.fn(),
    silenceAlerts: vi.fn(),
    dispose: vi.fn(),
  };
  const unsubscribe = vi.fn();
  const dispose = createSoundController(
    source,
    {
      state: () => initial,
      subscribe: (cb) => {
        settingsChanged = cb;
        return unsubscribe;
      },
    },
    sink,
    () => focus,
  );
  await Promise.resolve();
  return {
    source,
    sink,
    dispose,
    unsubscribe,
    focus: (id?: string) => {
      focus = id;
    },
    settings: (sound = DEFAULT_SOUND) => settingsChanged?.(setupState({ sound })),
  };
}
test("activity is monotonic, ignores invalid rates, caps the mix and preserves silence", () => {
  expect(activityIntensity([])).toBe(0);
  expect(activityIntensity([0, -1, NaN, Infinity])).toBe(0);
  expect(activityIntensity([100, 200])).toBe(activityIntensity([300]));
  expect(activityIntensity([100])).toBeLessThan(activityIntensity([1000]));
  expect(activityIntensity([50000, 50000])).toBe(1);
});
test("settles flapping transitions, groups simultaneous alerts and repeats unanswered attention", async () => {
  const f = await fixture();
  f.source.update("a", { state: "done" });
  vi.advanceTimersByTime(900);
  expect(f.sink.alert).not.toHaveBeenCalled();
  f.source.update("a", { state: "working" });
  vi.advanceTimersByTime(200);
  expect(f.sink.alert).not.toHaveBeenCalled();
  f.source.update("a", { state: "done" });
  f.source.update("b", { state: "needs_input" });
  vi.advanceTimersByTime(1000);
  expect(f.sink.alert).toHaveBeenCalledExactlyOnceWith("needs-you", 0.5);
  f.source.update("b", { reason: "same state, new verdict", verdictId: "next" });
  vi.advanceTimersByTime(REPEAT_MS - 100);
  expect(f.sink.alert).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(100);
  expect(f.sink.alert).toHaveBeenCalledTimes(2);
  f.source.update("b", { state: "quiet_ok" });
  vi.advanceTimersByTime(REPEAT_MS);
  expect(f.sink.alert).toHaveBeenCalledTimes(2);
  f.dispose();
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(f.sink.dispose).toHaveBeenCalledOnce();
});
test("debounces close verdicts without losing a settled completion", async () => {
  const f = await fixture();
  f.source.update("a", { state: "done" });
  vi.advanceTimersByTime(1000);
  expect(f.sink.alert).toHaveBeenCalledExactlyOnceWith("done", 0.5);
  f.source.update("b", { state: "done" });
  vi.advanceTimersByTime(1000);
  expect(f.sink.alert).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1000);
  expect(f.sink.alert).toHaveBeenCalledTimes(2);
  f.dispose();
});
test("mutes the focused terminal, consumes completion and postpones attention after leaving", async () => {
  const f = await fixture();
  f.focus("a");
  f.source.update("a", { state: "done" });
  vi.advanceTimersByTime(1000);
  f.focus();
  vi.advanceTimersByTime(REPEAT_MS);
  expect(f.sink.alert).not.toHaveBeenCalled();
  f.focus("a");
  f.source.update("a", { state: "needs_input" });
  vi.advanceTimersByTime(1000);
  f.focus();
  vi.advanceTimersByTime(REPEAT_MS - 100);
  expect(f.sink.alert).not.toHaveBeenCalled();
  vi.advanceTimersByTime(100);
  expect(f.sink.alert).toHaveBeenCalledOnce();
  f.dispose();
});
test("applies mute and volumes, mixes activity, removes closed sessions and unsubscribes", async () => {
  const f = await fixture(Promise.resolve(setupState()), [
    { ...row("a"), kind: "agent", agent: "Codex" },
    row("b"),
  ]);
  f.source.setActivity("a", 1000);
  f.source.setActivity("unknown", 99999);
  f.settings({
    ...DEFAULT_SOUND,
    working: true,
    workingVolume: 0.2,
    alerts: false,
  });
  expect(f.sink.working).toHaveBeenLastCalledWith(activityIntensity([1000]), 0.2);
  f.source.update("b", { state: "needs_input" });
  vi.advanceTimersByTime(2000);
  expect(f.sink.alert).not.toHaveBeenCalled();
  expect(f.sink.silenceAlerts).toHaveBeenCalled();
  f.settings({ ...DEFAULT_SOUND, alertVolume: 0 });
  vi.advanceTimersByTime(1000);
  f.settings();
  vi.advanceTimersByTime(REPEAT_MS);
  expect(f.sink.alert).toHaveBeenCalledOnce();
  f.source.getSnapshot = () => [];
  f.source.update("a", { state: "failed" });
  vi.advanceTimersByTime(REPEAT_MS);
  expect(f.sink.working).toHaveBeenLastCalledWith(0, 0.15);
  expect(f.sink.alert).toHaveBeenCalledOnce();
  f.dispose();
  f.sink.working.mockClear();
  f.source.setActivity("a", 100);
  vi.advanceTimersByTime(1000);
  expect(f.sink.working).not.toHaveBeenCalled();
});
test("waits for settings, ignores stale loads, handles failure and disposal during loading", async () => {
  let resolve: ((state: SetupState) => void) | undefined;
  const pending = new Promise<SetupState>((done) => {
    resolve = done;
  });
  const f = await fixture(pending, [{ ...row("a"), state: "done" }]);
  vi.advanceTimersByTime(2000);
  expect(f.sink.alert).not.toHaveBeenCalled();
  f.settings({ ...DEFAULT_SOUND, alerts: false });
  resolve?.(setupState());
  await Promise.resolve();
  vi.advanceTimersByTime(2000);
  expect(f.sink.alert).not.toHaveBeenCalled();
  f.dispose();
  const failed = await fixture(Promise.reject(new Error("offline")));
  vi.advanceTimersByTime(100);
  expect(failed.sink.working).toHaveBeenCalled();
  failed.dispose();
  let finish: ((state: SetupState) => void) | undefined;
  const late = await fixture(
    new Promise((done) => {
      finish = done;
    }),
  );
  late.dispose();
  finish?.(setupState());
  await Promise.resolve();
  expect(late.sink.working).not.toHaveBeenCalled();
});

test("refusal is immediate, independent of debounce, and respects switches and disposal", async () => {
  const f = await fixture();
  f.source.update("a", { state: "done" });
  vi.advanceTimersByTime(1000);
  f.dispose.refuse();
  f.dispose.refuse();
  expect(f.sink.alert.mock.calls.map((call) => String(call[0]))).toEqual([
    "done",
    "refusal",
    "refusal",
  ]);
  f.settings({ ...DEFAULT_SOUND, alerts: false });
  f.dispose.refuse();
  expect(f.sink.alert).toHaveBeenCalledTimes(3);
  f.settings();
  f.dispose();
  f.dispose.refuse();
  expect(f.sink.alert).toHaveBeenCalledTimes(3);
});

test("working audio excludes shell output while mixing active agents and tracking kind changes", async () => {
  const f = await fixture(Promise.resolve(setupState()), [
    { ...row("shell"), rate: 50000 },
    { ...row("agent"), kind: "agent", agent: "Codex", rate: 100 },
  ]);
  f.settings({ ...DEFAULT_SOUND, working: true });
  expect(f.sink.working).toHaveBeenLastCalledWith(activityIntensity([100]), 0.15);
  f.source.setActivity("shell", 100000);
  f.source.setActivity("agent", 200);
  vi.advanceTimersByTime(100);
  expect(f.sink.working).toHaveBeenLastCalledWith(activityIntensity([200]), 0.15);
  f.source.update("agent", { kind: "shell" });
  f.source.setActivity("agent", 50000);
  vi.advanceTimersByTime(100);
  expect(f.sink.working).toHaveBeenLastCalledWith(0, 0.15);
  f.source.update("shell", { kind: "agent", agent: "Claude", rate: 300 });
  vi.advanceTimersByTime(100);
  expect(f.sink.working).toHaveBeenLastCalledWith(activityIntensity([300]), 0.15);
  f.source.update("shell", { exited: true });
  f.source.setActivity("shell", 50000);
  vi.advanceTimersByTime(100);
  expect(f.sink.working).toHaveBeenLastCalledWith(0, 0.15);
  f.dispose();
});
