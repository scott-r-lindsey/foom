// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DirectionPad } from "../../../../src/renderer/board/direction-pad";
import { initialLayout, splitTile, placeSession } from "../../../../src/renderer/board/tiles";
afterEach(cleanup);
test.each(["left", "up", "right", "down"] as const)(
  "pads name, focus and dispatch %s, including refused buttons",
  (direction) => {
    const run = vi.fn();
    const initial = initialLayout();
    const layout = splitTile(initial, direction);
    const screen = render(
      <div role="menu">
        <DirectionPad kind="Split" layout={layout} run={run} />
        <DirectionPad kind="Grow" layout={layout} run={run} />
      </div>,
    );
    const split = within(screen.getByRole("group", { name: "Split" }));
    const grow = within(screen.getByRole("group", { name: "Grow" }));
    const arrow = split.getByRole("menuitem", { name: `Split ${direction}` });
    fireEvent.keyDown(arrow, {
      key: `Arrow${direction.charAt(0).toUpperCase()}${direction.slice(1)}`,
    });
    expect(document.activeElement).toBe(arrow);
    fireEvent.keyDown(arrow, { key: "a" });
    fireEvent.click(arrow);
    expect(run).toHaveBeenLastCalledWith(direction);
    fireEvent.click(grow.getByRole("menuitem", { name: `Grow ${direction}` }));
    expect(run).toHaveBeenLastCalledWith(`grow-${direction}`);
    const filled = placeSession(layout, "occupied");
    if (!filled) throw new Error("No layout");
    screen.rerender(
      <div role="menu">
        <DirectionPad kind="Grow" layout={{ ...filled, focused: initial.focused }} run={run} />
      </div>,
    );
    const refused = screen.getByRole("menuitem", { name: `Grow ${direction}` });
    expect(refused.getAttribute("aria-disabled")).toBe("true");
    refused.focus();
    expect(document.activeElement).toBe(refused);
    expect(refused.getAttribute("aria-describedby")).toBeTruthy();
    run.mockClear();
    fireEvent.click(refused);
    expect(run).not.toHaveBeenCalled();
  },
);
test("split refusal is described and inert at the resource limit", () => {
  let layout = initialLayout();
  for (let i = 0; i < 64; i++) layout = splitTile(layout, "down");
  const run = vi.fn();
  const screen = render(
    <div role="menu">
      <DirectionPad kind="Split" layout={layout} run={run} />
    </div>,
  );
  const arrow = screen.getByRole("menuitem", { name: "Split left" });
  expect(arrow.getAttribute("aria-disabled")).toBe("true");
  expect(screen.container.querySelector(".pad-reason")?.textContent).toBe(
    "Split depth limit reached",
  );
  fireEvent.click(arrow);
  expect(run).not.toHaveBeenCalled();
});
