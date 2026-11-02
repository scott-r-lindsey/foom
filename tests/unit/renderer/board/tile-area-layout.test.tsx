// @vitest-environment jsdom
import { act, fireEvent } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Board } from "../../../../src/renderer/board/board-view";
import type { BoardRow } from "../../../../src/renderer/board/board.d";
import {
  TILE_STORAGE,
  initialLayout,
  leaves,
  placeSession,
} from "../../../../src/renderer/board/tiles";
import type { SidebarCommand } from "../../../../src/shared/workspace";
import { arrangedLayout } from "../../../fixtures/tile-layout";
import { registerTileAreaFixture, setup } from "./tile-area-fixture";

registerTileAreaFixture();

test("irregular splits and maximize retain leaf elements and mounted controllers", async () => {
  const { screen, views, click, send } = setup();
  click(0);
  await act(async () => {});
  const first = screen.container.querySelector(".terminal-tile");
  const firstMount = views[0]?.mount.mock.calls.length;
  send("split-right");
  click(1);
  send("split-down");
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(3);
  expect(screen.container.querySelectorAll(".terminal-tile")[2]).toBe(first);
  const empty = screen.container.querySelector('[data-empty="true"]');
  expect(empty?.getAttribute("aria-hidden")).toBe("true");
  expect(empty?.querySelector(".tile-title")).toBeNull();
  click(2);
  await act(async () => {});
  const opens = views.map((view) => view.open.mock.calls.length);
  send("maximize");
  expect(screen.container.querySelectorAll('[data-behind="true"]')).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Restore tile" })).toBeTruthy();
  send("maximize");
  expect(views.map((view) => view.open.mock.calls.length)).toEqual(opens);
  expect(views.every((view) => view.dispose.mock.calls.length === 0)).toBe(true);
  send("split-down");
  await act(async () => {});
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(4);
  expect(views[0]?.mount.mock.calls.length).toBe(firstMount);
  expect(screen.container.contains(first)).toBe(true);
  expect(views.slice(0, 3).map((view) => view.open.mock.calls.length)).toEqual(opens);
});
test("full narrow placement replaces without refusal; hide retains space and refill reuses the view", async () => {
  const { screen, click, send, row, views } = setup();
  click(1);
  await act(async () => {});
  click(0);
  await act(async () => {});
  expect(row(0).dataset["refused"]).toBeUndefined();
  expect(views[0]?.open).toHaveBeenLastCalledWith("permission");
  send("split-right");
  click(1);
  send("tile-1");
  send("next-waiting");
  await act(async () => {});
  expect(views[0]?.open).toHaveBeenLastCalledWith("permission");
  const before = [...screen.container.querySelectorAll<HTMLElement>(".terminal-tile")].map(
    (tile) => tile.style.cssText,
  );
  send("hide-session");
  await act(async () => {});
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(2);
  expect(
    [...screen.container.querySelectorAll<HTMLElement>(".terminal-tile")].map(
      (tile) => tile.style.cssText,
    ),
  ).toEqual(before);
  expect(views[0]?.hide).toHaveBeenCalled();
  click(2);
  await act(async () => {});
  expect(views[1]?.open).toHaveBeenLastCalledWith("check");
  expect(views[0]?.dispose).not.toHaveBeenCalled();
});
test("keyboard-only splits, spatial focus, hide, close and empty layouts remain operable", async () => {
  const { screen, send, click } = setup();
  expect(screen.getByRole("group", { name: "Terminal tiles" })).toBeTruthy();
  send("split-right");
  send("split-down");
  click(0);
  await act(async () => {});
  send("left");
  expect(
    screen.container
      .querySelector('.terminal-tile[data-focused="true"]')
      ?.getAttribute("data-empty"),
  ).toBe("false");
  send("right");
  send("down");
  send("up");
  send("tile-9");
  send("hide-session");
  send("close-tile");
  send("close-tile");
  send("close-tile");
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(3);
  expect(
    screen.container.querySelector<HTMLElement>('[data-empty="true"]') ?? document.body,
  ).toBeTruthy();
});
test("gutter pointer and keyboard changes persist ratios and clamp to 15–85 percent", () => {
  const { screen, send, click } = setup();
  click(0);
  send("split-right");
  click(1);
  const area = screen.container.querySelector<HTMLElement>(".tile-area");
  if (!area) throw new Error("No area");
  vi.spyOn(area, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 10000,
    bottom: 600,
    width: 10000,
    height: 600,
    toJSON: () => ({}),
  });
  const gutter = screen.getByRole("separator", { name: "Resize tiles" });
  gutter.setPointerCapture = vi.fn();
  gutter.releasePointerCapture = vi.fn();
  vi.stubGlobal("PointerEvent", MouseEvent);
  fireEvent.pointerDown(gutter, { clientX: 5000 });
  fireEvent.pointerMove(gutter, { clientX: 7000 });
  expect(gutter.getAttribute("aria-valuenow")).toBe("70");
  fireEvent.pointerMove(gutter, { clientX: 11000 });
  expect(gutter.getAttribute("aria-valuenow")).toBe("85");
  fireEvent.pointerUp(gutter);
  fireEvent.keyDown(gutter, { key: "Home" });
  expect(gutter.getAttribute("aria-valuenow")).toBe("15");
  fireEvent.keyDown(gutter, { key: "ArrowRight" });
  expect(gutter.getAttribute("aria-valuenow")).toBe("20");
  fireEvent.keyDown(gutter, { key: "ArrowLeft" });
  fireEvent.keyDown(gutter, { key: "End" });
  fireEvent.keyDown(gutter, { key: "Escape" });
  expect(localStorage.getItem(TILE_STORAGE)).toContain('"ratio":0.85');
  send("split-down");
  click(2);
  const vertical = screen.getAllByRole("separator", { name: "Resize tiles" })[1];
  if (!vertical) throw new Error("Missing vertical gutter");
  vertical.setPointerCapture = vi.fn();
  vertical.releasePointerCapture = vi.fn();
  fireEvent.pointerMove(vertical, { clientY: 100 });
  fireEvent.pointerDown(vertical, { clientY: 300 });
  fireEvent.pointerMove(vertical, { clientY: 120 });
  expect(vertical.getAttribute("aria-valuenow")).toBe("20");
  fireEvent.pointerUp(vertical);
  fireEvent.lostPointerCapture(vertical);
  fireEvent.keyDown(vertical, { key: "ArrowUp" });
  fireEvent.keyDown(vertical, { key: "ArrowDown" });
  vi.unstubAllGlobals();
});
test("restored live sessions wait for inventory; removed sessions become empty without stopping processes", () => {
  const layout = placeSession(arrangedLayout(initialLayout(), "rows"), "permission");
  if (!layout) throw new Error("No layout");
  localStorage.setItem(TILE_STORAGE, JSON.stringify({ version: 1, ...layout }));
  const { screen, data } = setup();
  expect(screen.getByRole("region", { name: /Tile 1:/ }).getAttribute("data-empty")).toBe("false");
  expect(leaves(layout.tree)).toHaveLength(2);
  act(() => {
    data.update("permission", { id: "changed" });
  });
  expect(
    screen.container.querySelector<HTMLElement>('[data-empty="true"]') ?? document.body,
  ).toBeTruthy();
});
test("storage failures do not prevent layout changes", () => {
  const { screen, send, click } = setup();
  const failure = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  send("split-right");
  expect(screen.getByText("Unable to save tile layout.").textContent).toContain(
    "Unable to save tile layout",
  );
  click(0);
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(2);
  failure.mockRestore();
});

test("a zero-sized drag target is harmless and a missing session cannot be restored from storage", () => {
  const { screen, send } = setup();
  send("split-right");
  const gutter = screen.getByRole("separator", { name: "Resize tiles" });
  gutter.setPointerCapture = vi.fn();
  gutter.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(gutter);
  fireEvent.pointerMove(gutter, { clientX: 100 });
  expect(gutter.getAttribute("aria-valuenow")).toBe("50");
  fireEvent.pointerUp(gutter);
});

test.each(["full", "focused empty", "first empty"] as const)(
  "launch placement with %s tiles",
  async (mode) => {
    const { screen, click, source, data, views, send } = setup();
    click(0);
    send("split-right");
    if (mode !== "focused empty") click(1);
    if (mode === "first empty") {
      send("split-right");
      send("tile-2");
    }
    await act(async () => {});
    source.sidebarCommand = vi.fn(async (command: SidebarCommand) => {
      if (command.kind === "launch") data.update("check", { id: "launched" });
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Actions for fix/session-restore" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Shell" }));
    await act(async () => {});
    const target = mode === "first empty" ? 2 : 1;
    expect(views[target]?.open).toHaveBeenLastCalledWith("launched");
    expect(screen.container.querySelector('[data-refused="true"]')).toBeNull();
    expect(source.getSnapshot().some((row) => row.id === "build")).toBe(true);
    expect(views[0]?.open).toHaveBeenLastCalledWith("permission");
    if (mode === "first empty") expect(views[1]?.open).toHaveBeenLastCalledWith("build");
  },
);

test("keyboard gutters collapse empty sides and terminal numbering skips spaces", () => {
  const { screen, click, send } = setup();
  click(0);
  send("split-right");
  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize tiles" }), { key: "Home" });
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(1);
  send("split-right");
  click(1);
  send("tile-1");
  send("split-down");
  expect(screen.getByRole("button", { name: "Tile 2 menu" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Tile 3 menu" })).toBeNull();
  send("tile-2");
  expect(screen.getByRole("region", { name: /Tile 2:/ }).getAttribute("data-focused")).toBe("true");
});

test("gutter double-click and Enter even a run; footer and command tidy keep occupied views and focus", async () => {
  const { screen, send, click, views } = setup();
  click(0);
  send("split-right");
  click(1);
  send("split-right");
  click(2);
  await act(async () => {});
  const tiles = () => [...screen.container.querySelectorAll<HTMLElement>(".terminal-tile")];
  const original = tiles();
  const gutters = screen.getAllByRole("separator", { name: "Resize tiles" });
  fireEvent.doubleClick(gutters[1] ?? document.body);
  tiles().forEach((tile) => {
    expect(parseFloat(tile.style.width)).toBeCloseTo(100 / 3);
  });
  fireEvent.keyDown(gutters[0] ?? document.body, { key: "ArrowRight" });
  fireEvent.keyDown(gutters[1] ?? document.body, { key: "Enter" });
  tiles().forEach((tile) => {
    expect(parseFloat(tile.style.width)).toBeCloseTo(100 / 3);
  });
  send("split-down");
  send("maximize");
  send("tidy-tiles");
  expect(tiles()).toEqual(original);
  expect(tiles().every((tile) => tile.dataset["maximized"] === "false")).toBe(true);
  expect(tiles()[0]?.dataset["focused"]).toBe("true");
  send("split-right");
  send("tidy-tiles");
  expect(tiles()).toEqual(original);
  expect(views.slice(0, 3).every((view) => view.dispose.mock.calls.length === 0)).toBe(true);
});

test.each([100, 200, 300])(
  "background child arrivals split blank boards at %i cells without requesting focus",
  async (columns) => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return DOMRect.fromRect({ width: this.classList.contains("tile-area") ? columns * 8.4 : 0 });
    });
    const { screen, source, views } = setup();
    let navigate: ((id: string, background?: boolean) => void) | undefined;
    source.appMenu = {
      platform: "darwin",
      legal: vi.fn(),
      onLegal: vi.fn(),
      version: vi.fn(),
      setView: vi.fn().mockResolvedValue(undefined),
      commands: vi.fn().mockResolvedValue([]),
      shortcuts: vi.fn().mockResolvedValue([]),
      onShortcuts: () => () => {},
      execute: vi.fn().mockResolvedValue(undefined),
      onOpen: () => () => {},
      onSession: (callback) => {
        navigate = callback;
        return () => {};
      },
    };
    const row = source.getSnapshot()[0];
    if (!row) throw new Error("Missing row");
    const rows: BoardRow[] = [
      { ...row, orchestration: { role: "child", parentId: "parent", takenOver: false } },
    ];
    screen.rerender(<Board source={{ ...source, getSnapshot: () => rows }} />);
    const focusCalls = views.map((view) => view.focus.mock.calls.length);
    act(() => {
      navigate?.(row.id, true);
    });
    await act(async () => {});
    const tiles = [...screen.container.querySelectorAll<HTMLElement>(".terminal-tile")];
    expect(tiles).toHaveLength(columns / 100);
    expect(tiles[0]?.getAttribute("data-kind")).toBe("agent");
    expect(tiles[0]?.style.left).toBe("0%");
    expect(Number.parseFloat(tiles[0]?.style.width ?? "")).toBeCloseTo(100 / (columns / 100));
    expect(views.slice(0, focusCalls.length).map((view) => view.focus.mock.calls.length)).toEqual(
      focusCalls,
    );
    expect(views.slice(focusCalls.length).every((view) => view.focus.mock.calls.length === 0)).toBe(
      true,
    );
    vi.restoreAllMocks();
  },
);

test("board area resizing repairs measured spaces and persists without remounting occupants", async () => {
  let width = 2400;
  let repair: (() => void) | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {}
      observe(element: Element) {
        if (element.classList.contains("tile-area")) repair = this.callback;
      }
      disconnect = disconnect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return DOMRect.fromRect({
      width: this.classList.contains("tile-area") ? width : 8.4,
      height: 900,
    });
  });
  const { screen, click, send, views } = setup();
  click(0);
  send("split-right");
  send("split-right");
  await act(async () => {});
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(3);
  const occupied = screen.container.querySelector('[data-empty="false"]');
  const before = views.map((view) => view.open.mock.calls.length);
  width = 1100;
  act(() => {
    repair?.();
  });
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(2);
  expect(screen.container.contains(occupied)).toBe(true);
  expect(views.map((view) => view.open.mock.calls.length)).toEqual(before);
  const saved = localStorage.getItem(TILE_STORAGE);
  act(() => {
    repair?.();
  });
  expect(localStorage.getItem(TILE_STORAGE)).toBe(saved);
  screen.unmount();
  expect(disconnect).toHaveBeenCalled();
});
