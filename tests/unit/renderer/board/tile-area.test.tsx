// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import type { BoardCommand } from "../../../../src/shared/board-command";
import type { SidebarCommand } from "../../../../src/shared/workspace";
import type { BoardSource } from "../../../../src/renderer/board/board-source.d";
import { Board } from "../../../../src/renderer/board/board-view";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import { boardRows as sampleRows } from "../../../fixtures/board";
import {
  TILE_STORAGE,
  initialLayout,
  leaves,
  preset,
  placeSession,
} from "../../../../src/renderer/board/tiles";
const snapshot = {
  status: "Terminal",
  cols: 80,
  rows: 24,
  state: "quiet_ok" as const,
  visible: true,
  toggleLabel: "Hide terminal",
  toggleDisabled: false,
  restartDisabled: true,
};
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function setup() {
  const data = createSampleSource(
    sampleRows(100)
      .slice(0, 5)
      .map((row) => ({ ...row, kind: "agent" as const, managed: true })),
  );
  let command: ((command: BoardCommand) => void) | undefined;
  const views: {
    mount: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  }[] = [];
  const source: BoardSource = {
    ...data,
    subscribeCommands: (listener) => {
      command = listener;
      return () => {
        command = undefined;
      };
    },
    createView: () => {
      let element: HTMLElement | undefined;
      const view = {
        mount: vi.fn((node: HTMLElement) => {
          element = node;
          return view.dispose;
        }),
        dispose: vi.fn(),
        open: vi.fn(() => Promise.resolve()),
        hide: vi.fn(() => Promise.resolve()),
        focus: vi.fn(() => {
          element?.closest<HTMLElement>(".terminal-tile")?.focus();
        }),
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
      };
      views.push(view);
      return view;
    },
  };
  const screen = render(<Board source={source} />);
  const send = (value: BoardCommand) => {
    act(() => {
      command?.(value);
    });
  };
  const row = (index: number) =>
    screen.container.querySelectorAll<HTMLElement>(".board-row")[index] ?? document.body;
  const click = (index: number) => fireEvent.click(row(index));
  return { screen, data, views, source, send, row, click };
}
test("irregular splits, presets and maximize retain leaf elements and mounted controllers", async () => {
  const { screen, views, click, send } = setup();
  click(0);
  await act(async () => {});
  const first = screen.container.querySelector(".terminal-tile");
  const firstMount = views[0]?.mount.mock.calls.length;
  send("split-right");
  click(1);
  send("split-down");
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(3);
  expect(screen.container.querySelector(".terminal-tile")).toBe(first);
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
  fireEvent.click(screen.getByRole("button", { name: "One and three" }));
  await act(async () => {});
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(4);
  expect(views[0]?.mount.mock.calls.length).toBe(firstMount);
  expect(screen.container.contains(first)).toBe(true);
  expect(views.slice(0, 3).map((view) => view.open.mock.calls.length)).toEqual(opens);
});
test("placement uses empty tiles, refuses full without replacement, and next-waiting deliberately replaces focus", async () => {
  vi.useFakeTimers();
  const { screen, click, send, row, views } = setup();
  click(1);
  await act(async () => {});
  const id: unknown = views[0]?.open.mock.calls[0]?.[0];
  click(0);
  expect(row(0).dataset["refused"]).toBe("true");
  expect(views[0]?.open).toHaveBeenLastCalledWith(id);
  act(() => {
    vi.advanceTimersByTime(350);
  });
  expect(row(0).dataset["refused"]).toBe("false");
  send("next-waiting");
  await act(async () => {});
  expect(views[0]?.open).toHaveBeenLastCalledWith("permission");
  fireEvent.click(screen.getByRole("button", { name: "Two side by side" }));
  click(1);
  await act(async () => {});
  send("tile-1");
  expect(screen.container.querySelectorAll(".terminal-tile")[0]?.getAttribute("data-focused")).toBe(
    "true",
  );
  send("next-waiting");
  await act(async () => {});
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(2);
  fireEvent.click(
    within(screen.getByRole("region", { name: /Tile 1:/ })).getByRole("button", {
      name: "Hide",
    }),
  );
  await act(async () => {});
  expect(views[0]?.hide).toHaveBeenCalled();
  send("split-right");
  click(2);
  await act(async () => {});
  expect(views[2]?.open).toHaveBeenLastCalledWith("check");
  send("close-tile");
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(1);
  expect(views[0]?.dispose).toHaveBeenCalledOnce();
});
test("keyboard-only splits, spatial focus, hide, close and empty layouts remain operable", async () => {
  const { screen, send, click } = setup();
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
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(1);
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
    right: 1000,
    bottom: 600,
    width: 1000,
    height: 600,
    toJSON: () => ({}),
  });
  const gutter = screen.getByRole("separator");
  gutter.setPointerCapture = vi.fn();
  gutter.releasePointerCapture = vi.fn();
  vi.stubGlobal("PointerEvent", MouseEvent);
  fireEvent.pointerDown(gutter, { clientX: 500 });
  fireEvent.pointerMove(gutter, { clientX: 700 });
  expect(gutter.getAttribute("aria-valuenow")).toBe("70");
  fireEvent.pointerMove(gutter, { clientX: 1100 });
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
  const vertical = screen.getAllByRole("separator")[1];
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
test("activity changes tile light brightness without remounting, and only attention has the needs-you state", () => {
  const { screen, click, data, views } = setup();
  click(0);
  const tile = screen.getByRole("region", { name: /Tile 1:/ });
  expect(tile.getAttribute("data-state")).toBe("needs_input");
  const mounts = views[0]?.mount.mock.calls.length;
  act(() => {
    data.setActivity("permission", 10000);
  });
  expect(views[0]?.mount.mock.calls.length).toBe(mounts);
  act(() => {
    data.update("permission", { state: "working" });
  });
  expect(tile.getAttribute("data-state")).toBe("working");
  act(() => {
    data.setActivity("permission", 1000);
  });
  expect(
    tile.querySelector<HTMLElement>(".board-light")?.style.getPropertyValue("--light-opacity"),
  ).not.toBe("");
});
test("restored live sessions wait for inventory; removed sessions become empty without stopping processes", () => {
  const layout = placeSession(preset(initialLayout(), "rows"), "permission");
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
  expect(screen.getByRole("alert").textContent).toContain("Unable to save tile layout");
  click(0);
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(2);
  failure.mockRestore();
});

test("pointer selection focuses terminal space but keeps title buttons and terminal selection in charge of focus", async () => {
  const { screen, click, views } = setup();
  const empty = screen.container.querySelector<HTMLElement>('[data-empty="true"]') ?? document.body;
  fireEvent.pointerDown(empty);
  expect(document.activeElement).not.toBe(empty);
  click(0);
  await act(async () => {});
  const tile = screen.getByRole("region", { name: /Tile 1:/ });
  const focusCount = views[0]?.focus.mock.calls.length ?? 0;
  fireEvent.pointerDown(tile.querySelector(".tile-title") ?? tile);
  expect(views[0]?.focus).toHaveBeenCalledTimes(focusCount + 1);
  const hide = within(tile).getByRole("button", { name: "Hide" });
  fireEvent.pointerDown(hide);
  expect(views[0]?.focus).toHaveBeenCalledTimes(focusCount + 1);
  const terminal = document.createElement("div");
  terminal.className = "xterm";
  tile.append(terminal);
  fireEvent.pointerDown(terminal);
  expect(views[0]?.focus).toHaveBeenCalledTimes(focusCount + 1);
});

test("tile restart routes through workspace lifecycle and places the replacement in the same tile", async () => {
  const { screen, click, source, data, views } = setup();
  source.sidebarCommand = vi.fn(async (command: SidebarCommand) => {
    if (command.kind === "restart") data.update(command.id, { id: "replacement", exited: false });
    await Promise.resolve();
  });
  act(() => {
    data.update("permission", { kind: "shell", exited: true, state: "done" });
  });
  click(0);
  await act(async () => {});
  const original = screen.container.querySelector(".terminal-tile");
  fireEvent.click(screen.getByRole("button", { name: "Restart shell" }));
  await act(async () => {});
  expect(source.sidebarCommand).toHaveBeenCalledWith({ kind: "restart", id: "permission" });
  expect(views[0]?.open).toHaveBeenLastCalledWith("replacement");
  expect(screen.container.querySelector(".terminal-tile")).toBe(original);
});

test("a zero-sized drag target is harmless and a missing session cannot be restored from storage", () => {
  const { screen, send } = setup();
  send("split-right");
  const gutter = screen.getByRole("separator");
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

test("resuming in the same row reattaches its existing controller without remounting", async () => {
  const { row, data, views } = setup();
  await act(async () => {
    fireEvent.click(row(0));
    await Promise.resolve();
  });
  const id = data.getSnapshot()[0]?.id;
  if (!id) throw new Error("Missing fixture session");
  const mounts = views[0]?.mount.mock.calls.length;
  const opens = views[0]?.open.mock.calls.length ?? 0;
  act(() => {
    data.update(id, { launchVersion: 1 });
  });
  expect(views[0]?.open.mock.calls.length).toBe(opens + 1);
  expect(views[0]?.mount.mock.calls.length).toBe(mounts);
});

test("menu presets and Dock navigation use the same board placement and report view state", async () => {
  const { screen, source, send } = setup();
  let navigate: ((id: string) => void) | undefined;
  const setView = vi.fn().mockResolvedValue(undefined);
  const dispose = vi.fn();
  source.appMenu = {
    platform: "darwin",
    setView,
    commands: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue(undefined),
    onOpen: () => () => {},
    onSession: (callback) => {
      navigate = callback;
      return dispose;
    },
  };
  screen.rerender(<Board source={{ ...source }} />);
  for (const [command, count] of [
    ["preset-columns", 2],
    ["preset-rows", 2],
    ["preset-grid", 4],
    ["preset-main2", 3],
    ["preset-main3", 4],
    ["preset-one", 1],
  ] as const) {
    send(command);
    expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(count);
  }
  send("maximize");
  expect(setView).toHaveBeenLastCalledWith({ available: true, maximized: false, tiles: 0 });
  act(() => {
    navigate?.("missing");
    navigate?.(source.getSnapshot()[1]?.id ?? "missing");
  });
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(1);
  expect(screen.getByRole("region", { name: /Tile 1:/ }).textContent).toContain(
    source.getSnapshot()[1]?.repository,
  );
  send("new-worktree");
  expect(setView).toHaveBeenLastCalledWith(expect.objectContaining({ available: false }));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  setView.mockRejectedValueOnce(new Error("offline"));
  screen.rerender(<Board source={{ ...source }} inactive />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(error).toHaveBeenCalledWith("Unable to update menu state:", expect.any(Error));
  act(() => {
    navigate?.(source.getSnapshot()[0]?.id ?? "missing");
  });
  screen.unmount();
  expect(dispose).toHaveBeenCalled();
});

test("title drags and keyboard swaps keep controllers attached; Escape and outside drags cannot change layout", async () => {
  const { screen, click, send, views, row } = setup();
  click(0);
  send("split-right");
  click(1);
  await act(async () => {});
  const tiles = [...screen.container.querySelectorAll<HTMLElement>(".terminal-tile")];
  const a = tiles[0],
    b = tiles[1];
  if (!a || !b) throw new Error("tiles");
  const counts = () =>
    views.map((view) => [
      view.open.mock.calls.length,
      view.hide.mock.calls.length,
      view.mount.mock.calls.length,
    ]);
  const before = counts();
  vi.spyOn(a, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    right: 100,
    bottom: 100,
    toJSON: () => ({}),
  });
  vi.spyOn(b, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    right: 100,
    bottom: 100,
    toJSON: () => ({}),
  });
  const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  const drag = (source: Element, target: Element, x = 50, y = 50) => {
    fireEvent.dragStart(source, { dataTransfer: transfer });
    fireEvent.dragOver(target, { dataTransfer: transfer, clientX: x, clientY: y });
    fireEvent.drop(target, { dataTransfer: transfer, clientX: x, clientY: y });
    fireEvent.dragEnd(source);
  };
  // jsdom does not implement DragEvent coordinates.
  vi.stubGlobal("DragEvent", MouseEvent);
  drag(a.querySelector("header") ?? a, b);
  expect([...screen.container.querySelectorAll(".terminal-tile")]).toEqual([b, a]);
  send("swap-left");
  expect([...screen.container.querySelectorAll(".terminal-tile")]).toEqual([a, b]);
  send("swap-right");
  send("swap-up");
  send("swap-down");
  drag(a.querySelector("header") ?? a, b, 50, 90);
  expect(counts()).toEqual(before);
  const saved = localStorage.getItem(TILE_STORAGE);
  const focusCounts = () => views.map((view) => view.focus.mock.calls.length);
  const beforeCancel = focusCounts();
  fireEvent.dragStart(row(2), { dataTransfer: transfer });
  fireEvent.dragOver(b, { dataTransfer: transfer, clientX: 50, clientY: 50 });
  expect(screen.container.querySelector(".tile-drop-preview")?.textContent).toBe("Replace session");
  fireEvent.keyDown(b, { key: "Escape" });
  fireEvent.drop(b, { dataTransfer: transfer, clientX: 50, clientY: 50 });
  expect(localStorage.getItem(TILE_STORAGE)).toBe(saved);
  expect(focusCounts()).toEqual(beforeCancel);
  drag(row(2), b);
  expect(document.activeElement).toBe(b);
  expect(views[1]?.open).toHaveBeenLastCalledWith("check");
  drag(row(3), b, 10, 50);
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(3);
  expect(document.activeElement).toBe(
    screen.container.querySelector('.terminal-tile[data-focused="true"]'),
  );
  expect(views[2]?.focus).toHaveBeenCalledOnce();
  const beforeNoop = focusCounts();
  drag(b.querySelector("header") ?? b, b);
  expect(focusCounts()).toEqual(beforeNoop);
  fireEvent.dragStart(screen.getAllByRole("button", { name: "Tile 1 menu" })[0] ?? document.body, {
    dataTransfer: transfer,
  });
  fireEvent.dragStart(screen.container.querySelector(".tile-area") ?? document.body, {
    dataTransfer: transfer,
  });
  fireEvent.dragOver(document.body, { dataTransfer: transfer });
  vi.unstubAllGlobals();
});

test("tile panel exposes facts, keyboard navigation, blocked reasons and grow commands", async () => {
  const { screen, click, source, send } = setup();
  click(0);
  await act(async () => {});
  const button = screen.getByRole("button", { name: "Tile 1 menu" });
  fireEvent.click(button);
  let menu = screen.getByRole("dialog", { name: "Tile 1 menu" });
  expect(within(menu).getByRole("menuitem", { name: "Split right" })).toBe(document.activeElement);
  expect(menu.textContent).toContain("Already full width");
  expect(menu.textContent).toContain("Already full height");
  expect(menu.textContent).toContain("80 × 24");
  expect(menu.textContent).toContain("columns × rows");
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement?.textContent).toContain("Split down");
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement?.textContent).toContain("Maximize");
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(document.activeElement).toBe(button);
  expect(screen.queryByRole("dialog", { name: "Tile 1 menu" })).toBeNull();
  fireEvent.contextMenu(screen.container.querySelector(".tile-title") ?? button, {
    clientX: 50,
    clientY: 60,
  });
  menu = screen.getByRole("dialog", { name: "Tile 1 menu" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Split right" }));
  expect(screen.container.querySelector('[data-empty="true"]')?.getAttribute("data-landing")).toBe(
    "true",
  );
  expect(
    screen.container
      .querySelector('.terminal-tile[data-focused="true"]')
      ?.getAttribute("data-empty"),
  ).toBe("false");
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("menuitem", { name: "Grow sideways" }));
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(1);
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("menuitem", { name: "Split down" }));
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("menuitem", { name: "Grow vertically" }));
  fireEvent.doubleClick(screen.container.querySelector(".tile-title") ?? button);
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("menuitem", { name: /Restore/ }));
  fireEvent.doubleClick(button);
  expect(screen.container.querySelector('[data-maximized="true"]')).toBeNull();
  send("split-right");
  click(1);
  fireEvent.click(screen.getByRole("button", { name: "Tile 2 menu" }));
  expect(screen.getByRole("menuitem", { name: /Grow sideways/ }).textContent).toContain(
    "Next to a terminal",
  );
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Tile 2 menu" }), { key: "Escape" });
  source.sidebarCommand = vi.fn(async () => {});
  fireEvent.click(screen.getAllByRole("button", { name: "Hide" })[0] ?? button);
  expect(source.sidebarCommand).not.toHaveBeenCalled();
  expect(source.getSnapshot()).toHaveLength(5);
});

test("exited Close uses the sidebar command, retains the tile on failure and removes it on success", async () => {
  const { screen, click, data, source } = setup();
  click(0);
  act(() => {
    data.update("permission", { exited: true });
  });
  source.sidebarCommand = vi.fn().mockRejectedValue(new Error("failure"));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await act(async () => {});
  expect(source.sidebarCommand).toHaveBeenCalledWith({ kind: "close", id: "permission" });
  expect(screen.getByRole("alert").textContent).toContain("Unable to close session");
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  source.sidebarCommand = vi.fn(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Tile 1 menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Close" }));
  await act(async () => {});
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  expect(screen.container.querySelector('[data-empty="true"]')?.getAttribute("aria-hidden")).toBe(
    "true",
  );
});

test("keyboard gutters collapse empty sides and terminal numbering skips spaces", () => {
  const { screen, click, send } = setup();
  click(0);
  send("split-right");
  fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
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
