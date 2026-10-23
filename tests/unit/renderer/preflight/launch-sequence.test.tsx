// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  LaunchSequence,
  prefersReducedMotion,
} from "../../../../src/renderer/preflight/launch-sequence";

import { canvasContext } from "../flight-canvas-fixture";
let reduced = false;
let context: CanvasRenderingContext2D | null;
const { draw, ctx } = canvasContext();
beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: reduced }),
  });
  context = ctx;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((kind) =>
    kind === "2d" ? context : null,
  );
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

test("counts down and holds the moving steady state for ten seconds before fading", () => {
  const done = vi.fn();
  let frame: FrameRequestCallback | undefined;
  vi.mocked(requestAnimationFrame).mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  render(<LaunchSequence onDone={done} />);
  const dialog = screen.getByRole("dialog", { name: "Launch" });
  expect(document.activeElement).toBe(dialog);
  expect(screen.getByRole("status").textContent).toBe("3T-minus");
  expect(screen.getByText("Click or press Esc to continue")).toBeTruthy();
  expect(draw.arc).toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(700);
  });
  expect(screen.getByRole("status").textContent).toBe("2T-minus");
  act(() => {
    vi.advanceTimersByTime(700);
  });
  expect(screen.getByRole("status").textContent).toBe("1T-minus");
  act(() => {
    vi.advanceTimersByTime(700);
  });
  expect(screen.getByText("Takeoff was faster than expected.")).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(1800 + 9999);
  });
  const draws = draw.clearRect.mock.calls.length;
  frame?.(0);
  expect(draw.clearRect.mock.calls.length).toBeGreaterThan(draws);
  expect(done).not.toHaveBeenCalled();
  expect(dialog.dataset["fading"]).toBe("false");
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(dialog.dataset["fading"]).toBe("true");
  act(() => {
    vi.advanceTimersByTime(199);
  });
  expect(done).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(1);
    // A simultaneous user dismissal races the timer before React removes the dialog.
    fireEvent.click(dialog);
    fireEvent.keyDown(dialog, { key: "Escape" });
  });
  expect(done).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([0, 1000, 3900, 8900, 13900])(
  "click and skip keys dismiss once at %i ms and dispose without parent unmount",
  (elapsed) => {
    for (const key of [null, "Escape", "Enter", " "]) {
      const done = vi.fn();
      render(<LaunchSequence onDone={done} />);
      act(() => {
        vi.advanceTimersByTime(elapsed);
      });
      const dialog = screen.getByRole("dialog");
      fireEvent.keyDown(dialog, { key: "a" });
      expect(done).not.toHaveBeenCalled();
      if (key === null) fireEvent.click(document.querySelector("canvas") ?? dialog);
      else fireEvent.keyDown(dialog, { key });
      fireEvent.click(dialog);
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(done).toHaveBeenCalledOnce();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
      expect(vi.getTimerCount()).toBe(0);
      const draws = draw.clearRect.mock.calls.length;
      fireEvent.focus(window);
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(draw.clearRect.mock.calls.length).toBe(draws);
      expect(done).toHaveBeenCalledOnce();
      cleanup();
    }
  },
);

test("unmount cancels sequence timers and the drawing loop without finishing", () => {
  const done = vi.fn();
  const { unmount } = render(<LaunchSequence onDone={done} />);
  act(() => {
    vi.advanceTimersByTime(0);
  });
  unmount();
  expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  expect(vi.getTimerCount()).toBe(0);
  act(() => {
    vi.advanceTimersByTime(20_000);
  });
  expect(done).not.toHaveBeenCalled();
});

test("reduced motion holds the still final frame for ten seconds", () => {
  reduced = true;
  const done = vi.fn();
  render(<LaunchSequence onDone={done} />);
  expect(screen.queryByText("T-minus")).toBeNull();
  expect(document.querySelector("canvas")).toBeTruthy();
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(9999);
  });
  expect(done).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(done).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test.each([null, "a", "Escape", "Enter", " "])(
  "reduced motion dismisses on click or any key (%s) during the hold",
  (key) => {
    reduced = true;
    const done = vi.fn();
    render(<LaunchSequence onDone={done} />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    const dialog = screen.getByRole("dialog");
    if (key === null) fireEvent.click(dialog);
    else fireEvent.keyDown(dialog, { key });
    expect(done).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(done).toHaveBeenCalledOnce();
  },
);

test("can start at steady state and calls the latest finish callback without restarting", () => {
  const oldDone = vi.fn();
  const done = vi.fn();
  const { rerender } = render(<LaunchSequence startAt="steady" onDone={oldDone} />);
  expect(screen.queryByText("T-minus")).toBeNull();
  act(() => {
    vi.advanceTimersByTime(5000);
  });
  rerender(<LaunchSequence startAt="steady" onDone={done} />);
  act(() => {
    vi.advanceTimersByTime(4999);
  });
  expect(done).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog").dataset["fading"]).toBe("false");
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(screen.getByRole("dialog").dataset["fading"]).toBe("true");
  act(() => {
    vi.advanceTimersByTime(200);
  });
  expect(done).toHaveBeenCalledOnce();
  expect(oldDone).not.toHaveBeenCalled();
});

test("no canvas context or matchMedia is tolerated", () => {
  context = null;
  render(<LaunchSequence onDone={vi.fn()} />);
  expect(screen.getByRole("dialog")).toBeTruthy();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
  expect(prefersReducedMotion()).toBe(false);
});
