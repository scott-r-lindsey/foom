import { arrangedLayout } from "../../../fixtures/tile-layout";
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
  placeSession,
  placeContent,
  saveLayout,
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
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
  expect(views[0]?.open).toHaveBeenLastCalledWith("check");
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

test("shell restart stays in the sidebar menu and places the replacement in the same tile", async () => {
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
  expect(screen.queryByRole("button", { name: "Restart shell" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Actions for .* in fix\/session-restore$/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Restart shell" }));
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

test("menu commands and Dock navigation use the same board placement and report view state", async () => {
  const { screen, source, send, views } = setup();
  let navigate: ((id: string, background?: boolean) => void) | undefined;
  const setView = vi.fn().mockResolvedValue(undefined);
  const dispose = vi.fn();
  source.appMenu = {
    platform: "darwin",
    setView,
    commands: vi.fn().mockResolvedValue([]),
    shortcuts: vi.fn().mockResolvedValue([]),
    onShortcuts: () => () => {},
    execute: vi.fn().mockResolvedValue(undefined),
    onOpen: () => () => {},
    onSession: (callback) => {
      navigate = callback;
      return dispose;
    },
  };
  screen.rerender(<Board source={{ ...source }} />);
  send("toggle-sidebar");
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
  send("toggle-sidebar");
  send("maximize");
  expect(setView).toHaveBeenLastCalledWith({
    available: true,
    configAvailable: true,
    sidebarCollapsed: false,
    maximized: false,
    tiles: 0,
  });
  act(() => {
    navigate?.("missing");
    navigate?.(source.getSnapshot()[1]?.id ?? "missing");
  });
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(1);
  expect(screen.getByRole("region", { name: /Tile 1:/ }).textContent).toContain(
    source.getSnapshot()[1]?.repository,
  );
  await act(async () => {});
  const focused = screen.container.querySelector('.terminal-tile[data-focused="true"]');
  const focusCalls = views.map((view) => view.focus.mock.calls.length);
  act(() => {
    navigate?.(source.getSnapshot()[0]?.id ?? "missing", true);
    navigate?.("pending-child", true);
  });
  await act(async () => {});
  expect(screen.container.querySelectorAll('.terminal-tile[data-empty="false"]')).toHaveLength(2);
  expect(screen.container.querySelector('.terminal-tile[data-focused="true"]')).toBe(focused);
  expect(views.slice(0, focusCalls.length).map((view) => view.focus.mock.calls.length)).toEqual(
    focusCalls,
  );
  expect(views.at(-1)?.focus).not.toHaveBeenCalled();
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

test("empty-space placement marks only the drag target and clears on leave, end, cancel and drop", () => {
  const { screen, click, send, row } = setup();
  click(0);
  send("split-right");
  send("split-down");
  const empty = [...screen.container.querySelectorAll<HTMLElement>('[data-empty="true"]')];
  const landing = empty.find((tile) => tile.dataset["landing"] === "true");
  const other = empty.find((tile) => tile !== landing);
  const title = screen.container.querySelector(".tile-title");
  const area = screen.container.querySelector(".tile-area");
  if (!landing || !other || !title || !area) throw new Error("tiles");
  for (const tile of empty) {
    vi.spyOn(tile, "getBoundingClientRect").mockReturnValue({
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
  }
  vi.stubGlobal("DragEvent", MouseEvent);
  const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  const over = (target: Element) =>
    fireEvent.dragOver(target, {
      dataTransfer: transfer,
      clientX: 50,
      clientY: 50,
    });
  const mark = () => screen.container.querySelector<HTMLElement>(".tile-drop-preview");
  expect(mark()).toBeNull();
  const saved = localStorage.getItem(TILE_STORAGE);
  for (const source of [row(1), title]) {
    fireEvent.dragStart(source, { dataTransfer: transfer });
    expect(mark()).toBeNull();
    over(landing);
    expect(mark()?.textContent).toBe("Place here");
    expect(area.textContent).toContain("Drop to place here");
    expect(mark()?.style.left).toBe(landing.style.left);
    over(other);
    expect(mark()?.style.left).toBe(other.style.left);
    expect(mark()?.style.top).toBe(other.style.top);
    fireEvent.dragLeave(area, { relatedTarget: document.body });
    expect(mark()).toBeNull();
    over(landing);
    fireEvent.dragEnd(source);
    expect(mark()).toBeNull();
    fireEvent.dragStart(source, { dataTransfer: transfer });
    over(landing);
    fireEvent.keyDown(area, { key: "Escape" });
    expect(mark()).toBeNull();
    expect(localStorage.getItem(TILE_STORAGE)).toBe(saved);
  }
  fireEvent.dragStart(row(1), { dataTransfer: transfer });
  over(other);
  fireEvent.drop(other, { dataTransfer: transfer, clientX: 50, clientY: 50 });
  expect(mark()).toBeNull();
  expect(other.dataset["empty"]).toBe("false");
  expect(landing.dataset["empty"]).toBe("true");
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
    "Next to an occupied tile",
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

test("asynchronous Close focuses the surviving terminal after the command resolves", async () => {
  const { screen, click, data, source, send, views } = setup();
  click(0);
  send("split-right");
  click(1);
  send("tile-1");
  act(() => {
    data.update("permission", { exited: true });
  });
  let complete: (() => void) | undefined;
  source.sidebarCommand = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await act(async () => {});
  const focusedBefore = views[1]?.focus.mock.calls.length ?? 0;
  await act(async () => {
    complete?.();
    await Promise.resolve();
  });
  expect(views[1]?.focus).toHaveBeenCalledTimes(focusedBefore + 1);
  expect(document.activeElement).toBe(screen.getByRole("region", { name: /Tile 1:/ }));
});
test("New worktree opens the focused tile's repository, else the top one, else Add repository", async () => {
  const { screen, source, send, click, data } = setup();
  const addRepository = vi.fn(() => Promise.resolve(null));
  const branches = vi.fn(() =>
    Promise.resolve({ head: "main", local: [], remote: null, remoteBranches: [] }),
  );
  source.worktrees = { load: vi.fn(), branches, create: vi.fn(), remove: vi.fn(), addRepository };
  const panelTitle = () =>
    screen
      .getByLabelText("Branch for the new worktree")
      .closest(".sidebar-panel")
      ?.querySelector(".panel-title")?.textContent;
  const top = screen.container.querySelector(".repository-row .tree-label")?.textContent;
  send("new-worktree");
  await act(async () => {
    await Promise.resolve();
  });
  expect(document.activeElement).toBe(screen.getByLabelText("Branch for the new worktree"));
  expect(panelTitle()).toBe(top);
  fireEvent.keyDown(screen.getByLabelText("Branch for the new worktree"), { key: "Escape" });
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  const index = data.getSnapshot().findIndex((row) => row.repository !== top);
  const other = data.getSnapshot()[index]?.repository;
  click(index);
  await act(async () => {});
  send("new-worktree");
  await act(async () => {
    await Promise.resolve();
  });
  expect(panelTitle()).toBe(other);
  expect(branches).toHaveBeenLastCalledWith(other);
  expect(addRepository).not.toHaveBeenCalled();
});
test("New worktree with no repositories adds one", () => {
  const addRepository = vi.fn(() => Promise.resolve(null));
  let command: ((command: BoardCommand) => void) | undefined;
  const source: BoardSource = {
    ...createSampleSource([]),
    subscribeCommands: (listener) => {
      command = listener;
      return () => {};
    },
    worktrees: {
      load: () => new Promise(() => {}),
      branches: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      addRepository,
    },
  };
  render(<Board source={source} />);
  act(() => {
    command?.("new-worktree");
  });
  expect(addRepository).toHaveBeenCalledOnce();
});
test("the menu's Add repository uses the sidebar's picker and reports failure", async () => {
  const { screen, source, send } = setup();
  const addRepository = vi
    .fn<() => Promise<null>>()
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error("denied"));
  source.worktrees = {
    load: vi.fn(),
    branches: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    addRepository,
  };
  send("add-repository");
  expect(addRepository).toHaveBeenCalledOnce();
  send("add-repository");
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Unable to add repository.",
  );
});

test.each(["empty", "reassigned", "removed"] as const)(
  "restart remembers its own tile through inventory pruning (%s destination)",
  async (mode) => {
    const { screen, click, source, data, views, send } = setup();
    let finish: (() => void) | undefined;
    source.sidebarCommand = vi.fn(async (command: SidebarCommand) => {
      if (command.kind === "restart") {
        data.update(command.id, { id: "replacement", exited: false });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
    });
    act(() => {
      data.update("permission", { kind: "shell", exited: true, state: "done" });
    });
    click(0);
    send("split-right");
    click(1);
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", { name: /^Actions for .* in fix\/session-restore$/ }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Restart shell" }));
    await act(async () => {});
    expect(screen.container.querySelector('.terminal-tile[data-empty="true"]')).not.toBeNull();
    if (mode === "reassigned") click(2);
    if (mode === "removed") send("tidy-tiles");
    await act(async () => {
      finish?.();
      await Promise.resolve();
    });
    if (mode === "empty") {
      expect(views[0]?.open).toHaveBeenLastCalledWith("replacement");
      expect(views[1]?.open).toHaveBeenLastCalledWith("build");
    } else {
      expect(views[1]?.open).toHaveBeenLastCalledWith("replacement");
      if (mode === "reassigned") expect(views[0]?.open).toHaveBeenLastCalledWith("check");
      else expect(views[0]?.dispose).toHaveBeenCalledOnce();
    }
  },
);

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
  const gutters = screen.getAllByRole("separator");
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
  expect(tiles()[2]?.dataset["focused"]).toBe("true");
  send("split-right");
  send("tidy-tiles");
  expect(tiles()).toEqual(original);
  expect(views.slice(0, 3).every((view) => view.dispose.mock.calls.length === 0)).toBe(true);
});

test.each(["markdown", "html"] as const)(
  "%s previews share numbering, focus and tile commands without terminal attachment",
  async (kind) => {
    const data = createSampleSource(sampleRows(100).slice(0, 1));
    const row = data.getSnapshot()[0];
    if (!row) throw new Error("Missing row");
    const preview = {
      id: "preview",
      repository: row.repository,
      worktree: `${row.repository}/${row.branch}`,
      network: false,
      relativePath: "docs/test.md",
      kind,
    };
    const terminal = placeSession(arrangedLayout(initialLayout(), "columns"), row.id);
    if (!terminal) throw new Error("Missing terminal");
    const layout = placeContent(terminal, { kind: "preview", preview: preview.id });
    if (!layout) throw new Error("Missing preview");
    saveLayout(localStorage, { ...layout, focused: terminal.focused });
    const close = vi.fn(() => Promise.resolve());
    const network = vi.fn(async () => {});
    let command: ((command: BoardCommand) => void) | undefined;
    const source: BoardSource = {
      ...data,
      previews: {
        getSnapshot: () => [preview],
        pick: vi.fn(() => Promise.resolve(null)),
        bounds: vi.fn(async () => {}),
        close,
        network,
      },
      subscribeCommands: (listener) => {
        command = listener;
        return () => {
          command = undefined;
        };
      },
    };
    const screen = render(<Board source={source} />);
    const tile = screen.getByRole("region", { name: "Tile 2: docs/test.md" });
    expect(tile.querySelector(".board-light")).toBeNull();
    expect(tile.querySelector(".board-agent")?.textContent).toBe(
      kind === "markdown" ? "MD" : "HTML",
    );
    const sidebarRow = screen.getByRole("treeitem", { name: /preview: docs\/test.md/ });
    expect(within(sidebarRow).getByLabelText("Tile 2")).toBeTruthy();
    act(() => {
      command?.("tile-2");
    });
    expect(tile.getAttribute("data-focused")).toBe("true");
    fireEvent.click(within(sidebarRow).getByRole("button"));
    await act(async () => {});
    expect(tile.getAttribute("data-focused")).toBe("true");
    expect(document.activeElement).toBe(tile);
    fireEvent.click(within(tile).getByRole("button", { name: "Tile 2 menu" }));
    expect(screen.queryByRole("menuitem", { name: "Hide" })).toBeNull();
    expect(
      screen.getByText(kind === "markdown" ? "Markdown" : "HTML", { selector: "dd" }),
    ).toBeTruthy();
    expect(screen.getByText("Off", { selector: "dd" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Allow network…" }));
    await act(async () => {});
    expect(network).toHaveBeenCalledWith("preview", true);
    preview.network = true;
    screen.rerender(<Board source={{ ...source }} />);
    expect(within(tile).getByText("network")).toBeTruthy();
    fireEvent.click(within(tile).getByRole("button", { name: "Tile 2 menu" }));
    expect(screen.getByText("On", { selector: "dd" })).toBeTruthy();
    network.mockRejectedValueOnce(
      kind === "markdown" ? new Error("Network unavailable") : "failed",
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Block network" }));
    await act(async () => {});
    expect(network).toHaveBeenCalledWith("preview", false);
    expect(screen.getByRole("alert").textContent).toBe(
      kind === "markdown" ? "Network unavailable" : "Network change failed",
    );
    fireEvent.click(within(tile).getByRole("button", { name: "Tile 2 menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Maximize/ }));
    expect(tile.getAttribute("data-maximized")).toBe("true");
    fireEvent.click(within(tile).getByRole("button", { name: "Close" }));
    await act(async () => {});
    expect(close).toHaveBeenCalledExactlyOnceWith("preview");
    expect(tile.getAttribute("data-empty")).toBe("true");
  },
);
test("replacing a preview closes it and reports close failures", async () => {
  const data = createSampleSource(sampleRows(100).slice(0, 1));
  const preview = {
    id: "p",
    repository: "Foom",
    worktree: "/tree",
    network: false,
    relativePath: "page.html",
    kind: "html" as const,
  };
  const layout = placeContent(initialLayout(), { kind: "preview", preview: "p" });
  if (!layout) throw new Error("Missing preview");
  saveLayout(localStorage, layout);
  const close = vi.fn(() => Promise.reject(new Error("closed")));
  const screen = render(
    <Board
      source={{
        ...data,
        previews: {
          getSnapshot: () => [preview],
          pick: vi.fn(() => Promise.resolve(null)),
          bounds: vi.fn(async () => {}),
          close,
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toBe("Unable to close preview.");
});

test.each(["claude", "custom"])(
  "agent %s preview chrome identifies the opener and nests a sidebar-only row that the human can show",
  async (agent) => {
    const data = createSampleSource(
      sampleRows(100)
        .slice(0, 1)
        .map((row) => ({ ...row, agent })),
    );
    const row = data.getSnapshot()[0];
    if (!row) throw new Error("Missing row");
    const first = {
      id: "first",
      repository: row.repository,
      worktree: `${row.repository}/${row.branch}`,
      relativePath: "docs/first.html",
      kind: "html" as const,
      network: false,
      openedBy: { terminalId: row.id, agent },
    };
    const second = {
      ...first,
      id: "second",
      relativePath: "docs/second.md",
      kind: "markdown" as const,
    };
    const layout = placeContent(initialLayout(), { kind: "preview", preview: first.id });
    if (!layout) throw new Error("Missing layout");
    saveLayout(localStorage, layout);
    const close = vi.fn(() => Promise.resolve());
    const screen = render(
      <Board
        source={{
          ...data,
          previews: {
            getSnapshot: () => [first, second],
            pick: () => Promise.resolve(null),
            bounds: () => Promise.resolve(),
            close,
            getHistory: () => [
              { id: "event", terminalId: row.id, path: first.relativePath, at: 100 },
            ],
          },
        }}
      />,
    );
    const identity = agent === "claude" ? "Claude Code" : agent;
    const tile = screen.getByRole("region", {
      name: `Tile 1: docs/first.html, opened by ${identity}`,
    });
    expect(within(tile).getByText("opened by")).toBeTruthy();
    expect(tile.querySelector(".preview-opener .board-agent")?.textContent).toBe(
      agent === "claude" ? "CC" : "?",
    );
    const sidebar = screen.getByRole("treeitem", {
      name: `Markdown preview: docs/second.md, opened by ${identity}, not shown`,
    });
    expect(sidebar.querySelector('[data-child="true"]')).toBeTruthy();
    expect(sidebar.parentElement?.querySelector(".board-row")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: `Actions for ${identity} in ${row.branch}` }),
    );
    expect(screen.getByText("Opened preview docs/first.html")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(within(sidebar).getByRole("button"));
    await act(async () => {});
    const shown = screen.getByRole("region", {
      name: `Tile 1: docs/second.md, opened by ${identity}`,
    });
    expect(shown.getAttribute("data-focused")).toBe("true");
    expect(close).toHaveBeenCalledWith("first");
    fireEvent.click(within(shown).getByRole("button", { name: "Tile 1 menu" }));
    expect(screen.getByText(identity, { selector: "dd" })).toBeTruthy();
  },
);

test("panel picking fills the landing spot without focus, and handles cancel and refusal", async () => {
  const data = createSampleSource(sampleRows(100).slice(1, 2));
  const row = data.getSnapshot()[0];
  if (!row) throw new Error("Missing row");
  const preview = {
    id: "picked",
    repository: row.repository,
    worktree: `${row.repository}/${row.branch}`,
    relativePath: "page.html",
    kind: "html" as const,
    network: false,
  };
  const pick = vi.fn(() => Promise.resolve<string | null>(preview.id));
  const bounds = vi.fn(() => Promise.resolve());
  const close = vi.fn(() => Promise.resolve());
  const occupied = placeSession(arrangedLayout(initialLayout(), "columns"), row.id);
  if (!occupied) throw new Error("Missing layout");
  const landing = leaves(occupied.tree).find((tile) => !tile.content);
  if (!landing) throw new Error("Missing landing spot");
  saveLayout(localStorage, { ...occupied, landing: landing.id });
  const screen = render(
    <Board source={{ ...data, previews: { getSnapshot: () => [preview], pick, bounds, close } }} />,
  );
  const choose = async () => {
    fireEvent.click(screen.getByRole("button", { name: `Actions for ${row.branch}` }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Preview file…" }));
    await act(async () => {});
  };
  await choose();
  expect(pick).toHaveBeenCalledWith(preview.worktree);
  const tile = screen.getByRole("region", { name: "Tile 2: page.html" });
  expect(tile.getAttribute("data-tile")).toBe(landing.id);
  expect(tile.getAttribute("data-focused")).toBe("false");
  expect(bounds).toHaveBeenCalledWith(preview.id, expect.objectContaining({ visible: false }));
  pick.mockResolvedValueOnce(null);
  await choose();
  expect(close).not.toHaveBeenCalled();
  pick.mockRejectedValueOnce(new Error("Refused file"));
  await choose();
  expect(screen.getByRole("alert").textContent).toBe("Refused file");
});

test("preview bounds follow body measurement and transitions, hide under settings, and dispose observers", async () => {
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = observe;
      disconnect = disconnect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(12, 34, 320, 180),
  );
  const preview = {
    id: "p",
    repository: "repo",
    worktree: "/tree",
    relativePath: "page.html",
    kind: "html" as const,
    network: false,
  };
  const layout = placeContent(initialLayout(), { kind: "preview", preview: preview.id });
  if (!layout) throw new Error("Missing layout");
  saveLayout(localStorage, layout);
  const bounds = vi.fn(() => Promise.resolve());
  bounds.mockRejectedValueOnce(new Error("native view failed"));
  const source = {
    ...createSampleSource([]),
    previews: {
      getSnapshot: () => [preview],
      pick: () => Promise.resolve(null),
      close: () => Promise.resolve(),
      bounds,
    },
  };
  const screen = render(<Board source={source} />);
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toBe("Unable to display preview.");
  const tile = screen.getByRole("region", { name: "Tile 1: page.html" });
  fireEvent(tile, new Event("transitionend"));
  fireEvent(window, new Event("resize"));
  await act(async () => {});
  expect(bounds).toHaveBeenLastCalledWith("p", {
    x: 12,
    y: 34,
    width: 320,
    height: 180,
    visible: true,
  });
  screen.rerender(<Board source={source} inactive />);
  await act(async () => {});
  expect(bounds).toHaveBeenLastCalledWith("p", expect.objectContaining({ visible: false }));
  bounds.mockRejectedValueOnce(new Error("already closed"));
  screen.unmount();
  await act(async () => {});
  expect(disconnect).toHaveBeenCalledTimes(2);
  expect(observe).toHaveBeenCalledTimes(2);
  bounds.mockClear();
  fireEvent(window, new Event("resize"));
  expect(bounds).not.toHaveBeenCalled();
});

test("human previews on a full narrow board replace the eligible tile as human sessions do", async () => {
  const template = sampleRows(100)[1];
  if (!template) throw new Error("Missing row");
  const row = { ...template, state: "working" as const };
  const data = createSampleSource([row]);
  const preview = {
    id: "picked",
    repository: row.repository,
    worktree: `${row.repository}/${row.branch}`,
    relativePath: "page.html",
    kind: "html" as const,
    network: false,
  };
  const layout = placeSession(initialLayout(), row.id);
  if (!layout) throw new Error("Missing layout");
  saveLayout(localStorage, layout);
  const pick = vi.fn(() => Promise.resolve(preview.id));
  const screen = render(
    <Board
      source={{
        ...data,
        previews: {
          getSnapshot: () => [preview],
          pick,
          close: () => Promise.resolve(),
          bounds: () => Promise.resolve(),
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${row.branch}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Preview file…" }));
  await act(async () => {});
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(1);
  expect(screen.getByRole("region", { name: "Tile 1: page.html" }).getAttribute("data-tile")).toBe(
    layout.focused,
  );
});
