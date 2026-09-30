// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LaunchSequence, prefersReducedMotion } from "../src/renderer/launch-sequence";

let reduced = false;
let context: CanvasRenderingContext2D | null;
const draw = { clearRect: vi.fn(), fillRect: vi.fn(), fillStyle: "", globalAlpha: 1 };
beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: reduced }),
  });
  context = draw as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context);
  // Draw exactly once per test; the loop re-queues itself.
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("counts down, lifts off, then finishes once", () => {
  const done = vi.fn();
  render(<LaunchSequence onDone={done} />);
  const dialog = screen.getByRole("dialog", { name: "Launch" });
  expect(document.activeElement).toBe(dialog);
  expect(screen.getByRole("status").textContent).toBe("3T-minus");
  expect(draw.fillRect).toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(700);
  });
  expect(screen.getByRole("status").textContent).toBe("2T-minus");
  act(() => {
    vi.advanceTimersByTime(1400);
  });
  expect(screen.getByText("Takeoff was faster than expected.")).toBeTruthy();
  expect(done).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(2200);
  });
  expect(done).toHaveBeenCalledOnce();
  fireEvent.click(dialog);
  expect(done).toHaveBeenCalledOnce();
});

test("the starfield falls through and wraps", () => {
  let frame: FrameRequestCallback | undefined;
  vi.mocked(requestAnimationFrame).mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  const { unmount } = render(<LaunchSequence onDone={vi.fn()} />);
  act(() => {
    vi.advanceTimersByTime(2100);
  });
  // Enough frames at full speed to carry every star off the bottom.
  for (let index = 0; index < 400; index++) frame?.(0);
  expect(draw.clearRect).toHaveBeenCalled();
  unmount();
  expect(cancelAnimationFrame).toHaveBeenCalled();
});

test("reduced motion shows a still frame, and any skip key ends it", () => {
  reduced = true;
  const done = vi.fn();
  render(<LaunchSequence onDone={done} />);
  expect(screen.queryByText("T-minus")).toBeNull();
  expect(document.querySelector("canvas")).toBeNull();
  act(() => {
    vi.advanceTimersByTime(1200);
  });
  expect(done).toHaveBeenCalledOnce();
  cleanup();
  for (const key of ["Escape", "Enter", " "]) {
    const skip = vi.fn();
    render(<LaunchSequence onDone={skip} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "a" });
    expect(skip).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key });
    expect(skip).toHaveBeenCalledOnce();
    cleanup();
  }
});

test("no canvas context or matchMedia is tolerated", () => {
  context = null;
  render(<LaunchSequence onDone={vi.fn()} />);
  expect(screen.getByRole("dialog")).toBeTruthy();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
  expect(prefersReducedMotion()).toBe(false);
});
