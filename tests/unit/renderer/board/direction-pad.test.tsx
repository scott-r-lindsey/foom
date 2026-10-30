// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SpaceMenu } from "../../../../src/renderer/board/tile-menu";
import { DirectionPad } from "../../../../src/renderer/board/direction-pad";
import { initialLayout, splitTile, placeSession } from "../../../../src/renderer/board/tiles";
afterEach(cleanup);
test.each(["left", "up", "right", "down"] as const)(
  "pads name, focus and dispatch %s, including refused buttons",
  (direction) => {
    const run = vi.fn();
    const initial = initialLayout();
    const layout = splitTile(
      initial,
      ({ left: "right", right: "left", up: "down", down: "up" } as const)[direction],
    );
    const screen = render(
      <div role="menu">
        <DirectionPad kind="Split" layout={layout} run={run} />
        <DirectionPad kind="Grow" layout={layout} run={run} />
      </div>,
    );
    const split = within(screen.getByRole("group", { name: "Split" }));
    const grow = within(screen.getByRole("group", { name: "Grow" }));
    const arrow = split.getByRole("menuitem", { name: `Split terminal ${direction}` });
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
  const arrow = screen.getByRole("menuitem", { name: "Split terminal left" });
  expect(arrow.getAttribute("aria-disabled")).toBe("true");
  expect(screen.container.querySelector(".pad-reason")?.textContent).toBe(
    "Cannot move terminal right: Split depth limit reached",
  );
  fireEvent.click(arrow);
  expect(run).not.toHaveBeenCalled();
});

test("space menu keeps Tab navigation inside and dismisses at its boundaries", () => {
  const close = vi.fn();
  const run = vi.fn();
  const screen = render(
    <SpaceMenu
      anchor={document.body}
      point={{ x: 0, y: 0 }}
      layout={initialLayout()}
      close={close}
      action={run}
    />,
  );
  const down = screen.getByRole("menuitem", { name: "Split vertical" });
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowDown" });
  expect(document.activeElement).toBe(down);
  fireEvent.keyDown(down, { key: "Tab" });
  expect(close).not.toHaveBeenCalled();
  const shell = screen.getByRole("menuitem", { name: "New shell here" });
  shell.focus();
  fireEvent.keyDown(shell, { key: "Tab", shiftKey: true });
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(shell, { key: "ArrowDown" });
  const remove = screen.getByRole("menuitem", { name: "Close space" });
  expect(document.activeElement).toBe(remove);
  fireEvent.keyDown(remove, { key: "Tab" });
  expect(close).toHaveBeenCalledOnce();
  close.mockClear();
  const right = screen.getByRole("menuitem", { name: "Split horizontal" });
  right.focus();
  fireEvent.keyDown(right, { key: "Tab", shiftKey: true });
  expect(close).toHaveBeenCalledOnce();
});

test.each(["horizontal", "vertical"] as const)("empty-space menu offers Split %s", (axis) => {
  const action = vi.fn();
  const screen = render(
    <SpaceMenu
      anchor={document.body}
      point={{ x: 0, y: 0 }}
      layout={initialLayout()}
      close={vi.fn()}
      action={action}
    />,
  );
  expect(screen.getAllByRole("menuitem").map((button) => button.textContent)).toEqual([
    "Split horizontal",
    "Split vertical",
    "New shell here",
    "Close space",
  ]);
  fireEvent.click(screen.getByRole("menuitem", { name: `Split ${axis}` }));
  expect(action).toHaveBeenCalledWith(axis);
});

test.each(["horizontal", "vertical"] as const)(
  "empty Split %s keeps refused limits focusable and inert",
  (axis) => {
    let layout = initialLayout();
    for (let i = 0; i < 64; i++) layout = splitTile(layout, "vertical");
    const action = vi.fn();
    const close = vi.fn();
    const screen = render(
      <SpaceMenu
        anchor={document.body}
        point={{ x: 0, y: 0 }}
        layout={layout}
        close={close}
        action={action}
      />,
    );
    const button = screen.getByRole("menuitem", { name: `Split ${axis}` });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("Split depth limit reached");
    fireEvent.click(button);
    expect(action).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  },
);
