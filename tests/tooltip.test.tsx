// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { placeBubble, Tooltip } from "../src/renderer/tooltip";

afterEach(() => {
  cleanup();
});

test("opens on hover, focus or tap, describes its trigger, and Esc closes only it", () => {
  const outer = vi.fn();
  render(
    <div onKeyDown={outer}>
      <Tooltip className="tag" label="Hooks">
        Explained here.
      </Tooltip>
    </div>,
  );
  const trigger = screen.getByRole("button", { name: "Hooks" });
  const bubble = screen.getByRole("tooltip", { hidden: true });
  expect(trigger.getAttribute("aria-describedby")).toBe(bubble.id);
  expect(trigger.className).toBe("tag");
  expect(bubble.hidden).toBe(true);

  fireEvent.mouseEnter(trigger.parentElement as HTMLElement);
  expect(bubble.hidden).toBe(false);
  // Moving onto the bubble keeps it open; leaving the whole tooltip closes it.
  fireEvent.mouseEnter(bubble);
  expect(bubble.hidden).toBe(false);
  fireEvent.mouseLeave(trigger.parentElement as HTMLElement);
  expect(bubble.hidden).toBe(true);

  fireEvent.focus(trigger);
  expect(bubble.hidden).toBe(false);
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(bubble.hidden).toBe(true);
  expect(outer).not.toHaveBeenCalled();
  // Closed already: Esc goes on to whatever else handles it.
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(outer).toHaveBeenCalledOnce();
  fireEvent.keyDown(trigger, { key: "a" });

  fireEvent.click(trigger);
  expect(bubble.hidden).toBe(false);
  fireEvent.click(trigger);
  expect(bubble.hidden).toBe(true);
  fireEvent.focus(trigger);
  fireEvent.blur(trigger);
  expect(bubble.hidden).toBe(true);
});

test("opening one tooltip closes another", () => {
  render(
    <>
      <Tooltip label="One">First.</Tooltip>
      <Tooltip label="Two">Second.</Tooltip>
    </>,
  );
  const [first, second] = screen.getAllByRole("tooltip", { hidden: true });
  fireEvent.focus(screen.getByRole("button", { name: "One" }));
  expect(first?.hidden).toBe(false);
  fireEvent.mouseEnter(screen.getByRole("button", { name: "Two" }).parentElement as HTMLElement);
  expect(second?.hidden).toBe(false);
  expect(first?.hidden).toBe(true);
});

test("the bubble stays inside the window, flipping above when there's no room below", () => {
  const viewport = { width: 800, height: 600 };
  const bubble = { width: 300, height: 80 };
  const at = (left: number, top: number) => ({ left, top, right: left + 60, bottom: top + 20 });
  // Room below: under the trigger, left-aligned with it.
  expect(placeBubble(at(100, 100), bubble, viewport)).toEqual({ left: 100, top: 126 });
  // Near the right edge: shifted left to keep an 8px margin.
  expect(placeBubble(at(700, 100), bubble, viewport)).toEqual({ left: 492, top: 126 });
  // Near the bottom: above the trigger instead.
  expect(placeBubble(at(100, 550), bubble, viewport)).toEqual({ left: 100, top: 464 });
  // No room either way: below, where scrolling can reach it.
  expect(placeBubble(at(100, 40), { width: 300, height: 590 }, viewport).top).toBe(66);
  // Wider than the window: pinned to the left margin.
  expect(placeBubble(at(100, 100), { width: 900, height: 80 }, viewport).left).toBe(8);
});

test("an open bubble is placed against the window and follows resizes", () => {
  render(<Tooltip label="Hooks">Explained here.</Tooltip>);
  const trigger = screen.getByRole("button", { name: "Hooks" });
  const rect = vi.spyOn(trigger, "getBoundingClientRect");
  rect.mockReturnValue(new DOMRect(50, 10, 60, 20));
  fireEvent.focus(trigger);
  const bubble = screen.getByRole("tooltip");
  expect(bubble.style.top).toBe("36px");
  expect(bubble.style.left).toBe("50px");
  rect.mockReturnValue(new DOMRect(70, 10, 60, 20));
  fireEvent(window, new Event("resize"));
  expect(bubble.style.left).toBe("70px");
  fireEvent.blur(trigger);
});
