// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  AGENTS,
  DONE,
  LAYOUT,
  NEEDS_YOU,
  NoiseToCalm,
} from "../../../../src/renderer/preflight/welcome-noise";

let reduced = false;
beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: reduced }),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tiles = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".noise-tile")];
const stage = (root: HTMLElement) => root.querySelector<HTMLElement>(".welcome-noise");

test("ten terminals fold into lights, then one needs you and one is done", () => {
  const { container } = render(<NoiseToCalm random={() => 0.5} />);
  expect(stage(container)?.getAttribute("data-phase")).toBe("noise");
  expect(stage(container)?.getAttribute("aria-hidden")).toBe("true");
  expect(tiles(container)).toHaveLength(AGENTS.length);
  expect(tiles(container).every((tile) => tile.getAttribute("data-state") === "working")).toBe(
    true,
  );
  // Each terminal starts mid-session with colored output and a status line.
  expect(container.querySelector(".noise-output .tone-accent")).not.toBeNull();
  expect(container.querySelectorAll(".noise-status")).toHaveLength(AGENTS.length);
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  expect(stage(container)?.getAttribute("data-phase")).toBe("calm");
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(stage(container)?.getAttribute("data-phase")).toBe("settled");
  const settled = tiles(container);
  expect(settled[NEEDS_YOU]?.getAttribute("data-state")).toBe("needs_input");
  expect(settled[NEEDS_YOU]?.textContent).toContain("needs you");
  expect(settled[DONE]?.getAttribute("data-state")).toBe("done");
  expect(settled[DONE]?.textContent).toContain("done");
  expect(settled.filter((tile) => tile.getAttribute("data-state") === "working")).toHaveLength(8);
});

test("tiles are laid out like a window manager, and lights follow each terminal", () => {
  let seed = 0;
  // A fixed walk through [0, 1) keeps the output varied and the test repeatable.
  const { container } = render(<NoiseToCalm random={() => (seed = (seed + 0.618) % 1)} />);
  const light = (index: number) =>
    Number(tiles(container)[index]?.style.getPropertyValue("--light"));
  const area = LAYOUT.reduce((total, [, , w, h]) => total + w * h, 0);
  expect(area).toBe(100 * 100);
  expect(tiles(container)[0]?.style.getPropertyValue("--w")).toBe(String(LAYOUT[0][2]));
  const seen = new Set<number>();
  for (let tick = 0; tick < 40; tick++) {
    act(() => {
      vi.advanceTimersByTime(70);
    });
    seen.add(light(0));
  }
  expect(seen.size).toBeGreaterThan(3);
  expect([...seen].every((level) => level >= 0.25 && level <= 1)).toBe(true);
  act(() => {
    vi.advanceTimersByTime(5000);
  });
  // Lights that need you or are done hold steady.
  expect(light(NEEDS_YOU)).toBe(1);
  expect(light(DONE)).toBe(1);
});

test("reduced motion shows the settled board and schedules nothing", () => {
  reduced = true;
  const { container } = render(<NoiseToCalm />);
  expect(stage(container)?.getAttribute("data-phase")).toBe("settled");
  expect(tiles(container)[0]?.style.getPropertyValue("--light")).toBe("0.7");
  expect(vi.getTimerCount()).toBe(0);
});

test("unmounting stops the timers", () => {
  const { unmount } = render(<NoiseToCalm />);
  expect(vi.getTimerCount()).toBe(3);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
