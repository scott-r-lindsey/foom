import { afterEach, expect, test, vi } from "vitest";
import claude from "../../fixtures/agent-detection/claude-working.json";
import codex from "../../fixtures/agent-detection/codex-startup.json";
import { TerminalActivityMeter } from "../../../src/terminal-host/terminal-activity";
import { LightHistory } from "../../../src/renderer/board/light-activity";

// Replay recorded screen text with an explicit full-viewport redraw strategy.
// These are byte counts for this fixture renderer, not raw captures of CLI redraws.
const redraw = (tail: string[], cols: number, rows: number): string =>
  Array.from(
    { length: rows },
    (_, index) =>
      `\x1b[${String(index + 1)};1H${Array.from(tail[index] ?? "")
        .slice(0, cols)
        .join("")
        .padEnd(cols)}\x1b[K`,
  ).join("");

afterEach(() => vi.useRealTimers());

test.each([claude, codex])(
  "recorded $agent viewport redraw bytes depend on both dimensions",
  (fixture) => {
    const sizes = [
      [40, 12],
      [80, 24],
      [160, 48],
    ] as const;
    const bytes = sizes.map(([cols, rows]) => Buffer.byteLength(redraw(fixture.tail, cols, rows)));
    expect(bytes).toEqual(fixture.agent === "claude" ? [639, 2199, 8657] : [591, 2157, 8157]);
    // A spinner-only redraw is independent of viewport area.
    expect(Buffer.byteLength("\r\x1b[K✻ Spinning…")).toBe(19);
  },
);

test("host UTF-8 rates reach an eight-second trace and decay after a recorded redraw burst", () => {
  vi.useFakeTimers();
  const history = new LightHistory();
  let rate = 0;
  const meter = new TerminalActivityMeter({
    onActivity: (batch) => {
      rate = batch[0]?.rate ?? 0;
    },
  });
  const data = redraw(claude.tail, 40, 12);
  meter.start("fixture");
  let path = "";
  try {
    for (let now = 0; now <= 12000; now += 50) {
      if (now < 2000 && now % 100 === 0) {
        meter.output("fixture", data);
        meter.parsed("fixture");
      }
      vi.advanceTimersByTime(50);
      const sample = history.step(rate, now, 50, false, "agent");
      if (sample) path = sample.path;
      if (now === 1500) {
        expect(rate).toBeGreaterThan(6000);
        expect(path).toMatch(/L34\.0 1\.0$/);
      }
    }
    expect(rate).toBe(0);
    expect(path.match(/[ML]/g)).toHaveLength(33);
    expect(path).toMatch(/L34\.0 11\.0$/);
  } finally {
    meter.dispose();
  }
});
