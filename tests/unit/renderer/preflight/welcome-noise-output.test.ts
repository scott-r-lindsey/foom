import { expect, test } from "vitest";
import {
  clip,
  Feed,
  KEEP,
  type Line,
  TICK_MS,
} from "../../../../src/renderer/preflight/welcome-noise-output";

/** Replays values; the last one repeats. */
function sequence(...values: number[]) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
const text = (line: Line) => line.map(([, part]) => part).join("");

test("clipping keeps each segment's color", () => {
  const line: Line = [
    ["accent", "● "],
    ["plain", "Read"],
  ];
  expect(clip(line, 0)).toEqual([]);
  expect(clip(line, 3)).toEqual([
    ["accent", "● "],
    ["plain", "R"],
  ]);
  expect(clip(line, 99)).toEqual(line);
});

test("a feed starts with a full screen and keeps only the last lines", () => {
  const feed = new Feed("Codex", sequence(0.3, 0.6, 0.1, 0.9, 0.5));
  expect(feed.view().lines).toHaveLength(KEEP);
  for (let tick = 0; tick < 200; tick++) feed.step(true);
  expect(feed.view().lines).toHaveLength(KEEP);
  const ids = feed.view().lines.map((line) => line.id);
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
});

test("prose streams in a few characters at a time, with stalls", () => {
  // The last Claude Code template is prose. 0.99 picks it; 0.99 squared still bursts one line.
  const feed = new Feed("Claude Code", sequence(0));
  const streaming = new Feed("Claude Code", sequence(0.5, ...Array<number>(KEEP * 3).fill(0.99)));
  feed.step(true);
  streaming.step(true);
  const last = () => streaming.view().lines.at(-1)?.segments ?? [];
  expect(text(last())).toBe("");
  streaming.step(true);
  const first = text(last()).length;
  expect(first).toBeGreaterThan(0);
  expect(first).toBeLessThan(10);
  for (let tick = 0; tick < 30; tick++) streaming.step(true);
  expect(text(last())).toMatch(/^● .+\.$/);
});

test("output bursts, then pauses; brightness follows the rate", () => {
  const busy = new Feed("Antigravity", sequence(0.5, ...Array<number>(400).fill(0.95), 0));
  for (let tick = 0; tick < 3; tick++) busy.step(true);
  expect(busy.view().level).toBeGreaterThan(0.25);
  const quiet = new Feed("Antigravity", sequence(0.5));
  const before = quiet.view().lines.map((line) => line.id);
  for (let tick = 0; tick < 50; tick++) quiet.step(false);
  expect(quiet.view().lines.map((line) => line.id)).toEqual(before);
  expect(quiet.view().level).toBe(0.25);
});

test("a feed prints a burst, then waits", () => {
  // At 0.7: a four-line burst of tool output, then a nine-tick pause.
  const feed = new Feed("Codex", () => 0.7);
  const last = () => feed.view().lines.at(-1)?.id ?? -1;
  const start = last();
  feed.step(true);
  expect(last()).toBe(start + 4);
  for (let tick = 0; tick < 9; tick++) feed.step(true);
  expect(last()).toBe(start + 4);
  feed.step(true);
  expect(last()).toBe(start + 8);
});

test("each agent has its own status line and the clock keeps running", () => {
  const status = (agent: "Claude Code" | "Codex" | "Antigravity") => {
    const feed = new Feed(agent, sequence(0));
    const ticks = Math.ceil(2000 / TICK_MS);
    for (let tick = 0; tick < ticks; tick++) feed.step(false);
    return text(feed.view().status);
  };
  expect(status("Claude Code")).toMatch(/Thinking… \(2s · esc to interrupt\)$/);
  expect(status("Codex")).toMatch(/Working \(2s • esc to interrupt\)$/);
  expect(status("Antigravity")).toMatch(/ 2s$/);
});
