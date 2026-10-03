// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  AGENTS,
  DONE,
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
  expect(container.querySelector(".noise-output")?.textContent).toContain("●");
  act(() => {
    vi.advanceTimersByTime(2200);
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

test("working lights follow made-up output and stay in range", () => {
  let next = 1;
  const { container } = render(<NoiseToCalm random={() => next} />);
  const level = () => Number(tiles(container)[0]?.style.getPropertyValue("--light"));
  for (let index = 0; index < 6; index++)
    act(() => {
      vi.advanceTimersByTime(420);
    });
  expect(level()).toBe(1);
  next = 0;
  for (let index = 0; index < 10; index++)
    act(() => {
      vi.advanceTimersByTime(420);
    });
  expect(level()).toBe(0.25);
  act(() => {
    vi.advanceTimersByTime(4200);
  });
  // Lights that need you or are done hold steady.
  expect(tiles(container)[NEEDS_YOU]?.style.getPropertyValue("--light")).toBe("1");
});

test("reduced motion shows the settled board and schedules nothing", () => {
  reduced = true;
  const { container } = render(<NoiseToCalm />);
  expect(stage(container)?.getAttribute("data-phase")).toBe("settled");
  expect(vi.getTimerCount()).toBe(0);
});

test("unmounting stops the timers", () => {
  const { unmount } = render(<NoiseToCalm />);
  expect(vi.getTimerCount()).toBe(3);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
