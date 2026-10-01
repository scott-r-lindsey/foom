import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TerminalActivityMeter } from "../../../src/terminal-host/terminal-activity";
import type { TerminalActivity } from "../../../src/shared/desktop";
const onActivity = vi.fn<(batch: TerminalActivity[]) => void>();
const onQuiet = vi.fn();
let meter: TerminalActivityMeter;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  meter = new TerminalActivityMeter({ onActivity, onQuiet });
});
afterEach(() => {
  meter.dispose();
  vi.useRealTimers();
});
test("ten busy terminals share one batch per tick with UTF-8 byte rates and decay", () => {
  for (let i = 0; i < 10; i++) {
    meter.start(String(i));
    for (let j = 0; j < 100; j++) {
      meter.output(String(i), "é");
      meter.parsed(String(i), "progress");
    }
  }
  expect(onActivity).not.toHaveBeenCalled();
  vi.advanceTimersByTime(100);
  expect(onActivity).toHaveBeenCalledTimes(1);
  expect(onActivity.mock.calls[0]?.[0]).toHaveLength(10);
  expect(onActivity.mock.calls[0]?.[0][0]?.rate).toBeCloseTo(2000 * (1 - Math.exp(-0.2)));
  vi.advanceTimersByTime(100);
  expect(onActivity.mock.calls[1]?.[0][0]?.rate).toBeCloseTo(
    2000 * (1 - Math.exp(-0.2)) * Math.exp(-0.2),
  );
  vi.advanceTimersByTime(10000);
  expect(onQuiet).toHaveBeenCalledTimes(10);
  expect(onActivity.mock.lastCall?.[0].every(({ rate }) => rate === 0)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  meter.output("0", "again");
  meter.parsed("0", "again");
  vi.advanceTimersByTime(2000);
  expect(onQuiet).toHaveBeenCalledTimes(11);
});
test.each(["Continue?", "Proceed (y/n)", "Password:", "Press Enter."])(
  "quiet prompts use a short debounce: %s",
  (line) => {
    meter.start("a");
    meter.output("a", line);
    meter.parsed("a", line);
    vi.advanceTimersByTime(499);
    expect(onQuiet).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onQuiet).toHaveBeenCalledWith("a");
    vi.advanceTimersByTime(500);
    expect(onQuiet).toHaveBeenCalledTimes(1);
  },
);
test("midstream waits longer, resets on new output, and never fires ahead of parsing", () => {
  meter.start("a");
  meter.output("a", "Installing...");
  meter.parsed("a", "Installing...");
  vi.advanceTimersByTime(1900);
  expect(onQuiet).not.toHaveBeenCalled();
  meter.output("a", "more");
  vi.advanceTimersByTime(2100);
  expect(onQuiet).not.toHaveBeenCalled();
  meter.parsed("a", "more");
  vi.advanceTimersByTime(100);
  expect(onQuiet).toHaveBeenCalledTimes(1);
});
test("removal, disposal, empty output and stale parser callbacks cannot emit events", () => {
  meter.output("empty", "");
  meter.parsed("missing", "?");
  expect(vi.getTimerCount()).toBe(0);
  meter.start("a");
  meter.output("a", "?");
  meter.start("b");
  meter.output("b", "x");
  meter.remove("a");
  meter.parsed("a", "?");
  vi.advanceTimersByTime(100);
  expect(onActivity.mock.lastCall?.[0].map(({ id }) => id)).toEqual(["b"]);
  meter.remove("b");
  vi.advanceTimersByTime(5000);
  expect(onQuiet).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
test("telemetry consumers are optional", () => {
  meter.dispose();
  meter = new TerminalActivityMeter({});
  meter.start("a");
  meter.output("a", "?");
  meter.parsed("a", "?");
  vi.advanceTimersByTime(10000);
  expect(vi.getTimerCount()).toBe(0);
});

test("a terminal silent from launch becomes quiet once", () => {
  meter.start("silent");
  vi.advanceTimersByTime(1900);
  expect(onQuiet).not.toHaveBeenCalled();
  vi.advanceTimersByTime(100);
  expect(onQuiet).toHaveBeenCalledWith("silent");
  expect(onActivity).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
