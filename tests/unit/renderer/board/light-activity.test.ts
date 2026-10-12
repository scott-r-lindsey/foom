// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  LightHistory,
  lightState,
  movingLight,
  outputLevel,
  smoothLevel,
  subscribeLights,
} from "../../../../src/renderer/board/light-activity";
import { light } from "../../../../src/renderer/board/board";
import { boardRows } from "../../../fixtures/board";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("log level exposes trickles, saturates builds, and attacks faster than it releases", () => {
  expect(outputLevel(-2)).toBe(0);
  expect(outputLevel(0)).toBe(0);
  expect(outputLevel(200)).toBeCloseTo(0.388);
  expect(outputLevel(4000)).toBe(1);
  expect(outputLevel(8000)).toBe(1);
  expect(smoothLevel(0, 1, 120)).toBeCloseTo(1 - Math.exp(-1));
  expect(smoothLevel(1, 0, 700)).toBeCloseTo(Math.exp(-1));
});
test("rate targets stay bounded in frequency, traces retain eight seconds, reduced motion steps once a second", () => {
  const history = new LightHistory();
  history.step(4000, 0, 120, false);
  history.step(0, 50, 50, false);
  expect(history.level).toBeGreaterThan(0.7);
  let sample;
  for (let now = 250; now <= 12000; now += 250) sample = history.step(0, now, 250, false);
  expect(sample?.path.match(/[ML]/g)).toHaveLength(33);
  expect(sample?.path.startsWith("M0.0")).toBe(true);
  const reduced = new LightHistory();
  expect(reduced.step(4000, 0, 120, true)?.level).toBe(2 / 3);
  expect(reduced.step(0, 999, 999, true)).toBeUndefined();
  expect(reduced.step(0, 1000, 1, true)?.level).toBe(0);
});
test("shells stay neutral except attention, exited states retain only final result colors", () => {
  const base = boardRows(0)[0];
  if (!base) throw new Error("Missing fixture");
  for (const state of ["working", "needs_input", "done", "failed", "quiet_ok"] as const) {
    const agent = { ...base, kind: "agent" as const, state };
    const shell = { ...agent, kind: "shell" as const };
    expect(movingLight(agent)).toBe(state === "working");
    expect(movingLight(shell)).toBe(state !== "needs_input");
    expect(lightState(shell)).toBe(state === "needs_input" ? state : "shell");
    for (const row of [agent, shell]) {
      const exited = { ...row, exited: true };
      expect(movingLight(exited)).toBe(false);
      expect(light(exited).label).toContain("Exited");
      expect(light(exited).opacity).toBe(0.85);
    }
    expect(lightState({ ...agent, exited: true })).toBe(
      state === "done" || state === "failed" ? state : "quiet_ok",
    );
    expect(lightState({ ...shell, exited: true })).toBe("shell");
  }
});
test("DOM subscription smooths without publishing snapshots and discards closed/relaunched histories", () => {
  vi.useFakeTimers();
  const row = boardRows(0)[1];
  if (!row) throw new Error("Missing fixture");
  const source = createSampleSource([row]);
  const publish = vi.fn();
  source.subscribe(publish);
  const element = document.createElement("span");
  const trace = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const stop = subscribeLights(source, () =>
    source.getSnapshot().map((row) => ({ row, element, trace })),
  );
  source.setActivity(row.id, 4000);
  source.setActivity("unknown", 9000);
  vi.advanceTimersByTime(1000);
  expect(Number(element.style.getPropertyValue("--activity"))).toBeGreaterThan(0.99);
  expect(trace.getAttribute("d")).toContain("L");
  expect(publish).not.toHaveBeenCalled();
  source.update(row.id, { exited: true });
  vi.advanceTimersByTime(50);
  expect(trace.getAttribute("d")).toBe("");
  source.update(row.id, { exited: false, launchVersion: 1, rate: 0 });
  vi.advanceTimersByTime(50);
  expect(element.style.getPropertyValue("--activity")).toBe("0");
  source.update(row.id, { launchVersion: 2 });
  vi.advanceTimersByTime(50);
  stop();
  source.setActivity(row.id, 4000);
  vi.advanceTimersByTime(1000);
  expect(element.style.getPropertyValue("--activity")).toBe("0");
  expect(vi.getTimerCount()).toBe(0);
});
test("reduced-motion DOM levels and trace update only on the one second cadence", () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const row = boardRows(0)[1];
  if (!row) throw new Error("Missing fixture");
  const source = createSampleSource([row]);
  const element = document.createElement("span");
  const stop = subscribeLights(source, () => [{ row, element }]);
  source.setActivity(row.id, 4000);
  vi.advanceTimersByTime(950);
  expect(element.style.getPropertyValue("--activity")).toBe("0");
  vi.advanceTimersByTime(50);
  expect(element.style.getPropertyValue("--activity")).toBe("1");
  stop();
});

test("a hidden row retains the final zero before remount, but not across relaunch or close", () => {
  vi.useFakeTimers();
  const fixture = boardRows(0)[1];
  if (!fixture) throw new Error("Missing fixture");
  const row = { ...fixture, rate: 4000 };
  const source = createSampleSource([row]);
  const element = document.createElement("span");
  let visible = true;
  const stop = subscribeLights(source, () =>
    visible ? source.getSnapshot().map((row) => ({ row, element })) : [],
  );
  vi.advanceTimersByTime(1000);
  visible = false;
  vi.advanceTimersByTime(50);
  visible = true;
  source.setActivity(row.id, 0);
  vi.advanceTimersByTime(10000);
  expect(Number(element.style.getPropertyValue("--activity"))).toBe(0);
  source.update(row.id, { launchVersion: 1 });
  vi.advanceTimersByTime(1000);
  expect(Number(element.style.getPropertyValue("--activity"))).toBeGreaterThan(0.99);
  source.setActivity(row.id, 0);
  source.update(row.id, { exited: true });
  source.setActivity(row.id, 4000);
  vi.advanceTimersByTime(50);
  stop();
  expect(vi.getTimerCount()).toBe(0);
});
