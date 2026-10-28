// @vitest-environment jsdom
import { act, fireEvent, render, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { BoardSource } from "../../../../src/renderer/board/board-source.d";
import { Board } from "../../../../src/renderer/board/board-view";
import { createSampleSource } from "../../../../src/renderer/board/sample-board-source";
import type { BoardCommand } from "../../../../src/shared/board-command";
import type { SidebarCommand } from "../../../../src/shared/workspace";
import { registerTileAreaFixture, setup } from "./tile-area-fixture";

registerTileAreaFixture();

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

test("menu commands and Dock navigation use the same board placement and report view state", async () => {
  const { screen, source, send, views } = setup();
  let navigate: ((id: string, background?: boolean) => void) | undefined;
  const setView = vi.fn().mockResolvedValue(undefined);
  const dispose = vi.fn();
  source.appMenu = {
    platform: "darwin",
    legal: vi.fn(),
    onLegal: vi.fn(),
    version: vi.fn(),
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

test("tile panel exposes facts, keyboard navigation, blocked reasons and grow commands", async () => {
  const { screen, click, source, send } = setup();
  click(0);
  await act(async () => {});
  const button = screen.getByRole("button", { name: "Tile 1 menu" });
  fireEvent.click(button);
  let menu = screen.getByRole("dialog", { name: "Tile 1 menu" });
  expect(within(menu).getByRole("menuitem", { name: "Split right" })).toBe(document.activeElement);
  expect(menu.textContent).toContain("At the left edge");
  expect(menu.textContent).toContain("At the top edge");
  expect(menu.textContent).toContain("80 × 24");
  expect(menu.textContent).toContain("columns × rows");
  fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowDown" });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Split down");
  fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowLeft" });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Split left");
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
  fireEvent.click(screen.getByRole("menuitem", { name: "Grow right" }));
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(1);
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("menuitem", { name: "Split down" }));
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("menuitem", { name: "Grow down" }));
  fireEvent.doubleClick(screen.container.querySelector(".tile-title") ?? button);
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("menuitem", { name: /Restore/ }));
  fireEvent.doubleClick(button);
  expect(screen.container.querySelector('[data-maximized="true"]')).toBeNull();
  send("split-right");
  click(1);
  fireEvent.click(screen.getByRole("button", { name: "Tile 2 menu" }));
  expect(screen.getByRole("menuitem", { name: "Grow left" }).getAttribute("aria-disabled")).toBe(
    "true",
  );
  expect(
    screen.getByRole("menuitem", { name: "Grow left" }).getAttribute("aria-describedby"),
  ).toBeTruthy();
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

test("empty-space menu splits, closes, dismisses and launches through the home-shell path", async () => {
  const { screen, click, send, source, data, views } = setup();
  click(0);
  send("split-right");
  const space = () =>
    screen.container.querySelector<HTMLElement>('[data-empty="true"]') ?? document.body;
  const open = () => fireEvent.contextMenu(space(), { clientX: 100, clientY: 120 });
  open();
  expect(screen.getByRole("menu", { name: "Empty space" })).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Grow" })).toBeNull();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  expect(screen.queryByRole("menu", { name: "Empty space" })).toBeNull();
  open();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu", { name: "Empty space" })).toBeNull();
  open();
  fireEvent.pointerDown(space());
  expect(screen.queryByRole("menu", { name: "Empty space" })).toBeNull();
  open();
  fireEvent.click(screen.getByRole("menuitem", { name: "Split up" }));
  expect(screen.container.querySelectorAll('[data-empty="true"]')).toHaveLength(2);
  open();
  fireEvent.click(screen.getByRole("menuitem", { name: "Close space" }));
  expect(screen.container.querySelectorAll('[data-empty="true"]')).toHaveLength(1);
  const target = space();
  source.sidebarCommand = vi.fn(async () => {
    data.update("permission", { id: "home-created", kind: "shell", home: true });
    await Promise.resolve();
    return { terminalId: "home-created" };
  });
  open();
  fireEvent.click(screen.getByRole("menuitem", { name: "New shell here" }));
  await act(async () => {});
  expect(source.sidebarCommand).toHaveBeenCalledWith({ kind: "home-shell" });
  expect(target.getAttribute("data-empty")).toBe("false");
  expect(views.some((view) => view.open.mock.calls.some(([id]) => id === "home-created"))).toBe(
    true,
  );
});

test.each(["left", "up", "right", "down"] as const)(
  "tile panel splits and grows %s without replacing its controller",
  async (direction) => {
    const { screen, click, views } = setup();
    click(0);
    await act(async () => {});
    const tile = screen.container.querySelector('[data-empty="false"]');
    const button = screen.getByRole("button", { name: "Tile 1 menu" });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitem", { name: `Split ${direction}` }));
    expect(screen.container.querySelectorAll('[data-empty="true"]')).toHaveLength(1);
    expect(screen.container.querySelector('.terminal-tile[data-focused="true"]')).toBe(tile);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitem", { name: `Grow ${direction}` }));
    await act(async () => {});
    expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(1);
    expect(screen.container.querySelector(".terminal-tile")).toBe(tile);
    expect(views[0]?.dispose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(tile);
  },
);

test.each(["filled", "removed"] as const)(
  "new shell keeps a %s destination safe while launching",
  async (mode) => {
    const { screen, click, send, source, data, views } = setup();
    click(0);
    send("split-right");
    vi.spyOn(
      screen.getByRole("group", { name: "Terminal tiles" }),
      "getBoundingClientRect",
    ).mockReturnValue(new DOMRect(0, 0, 2400, 900));
    let finish: (() => void) | undefined;
    source.sidebarCommand = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      data.update("check", { id: "home-created", kind: "shell", home: true });
      return { terminalId: "home-created" };
    });
    const space = screen.container.querySelector('[data-empty="true"]') ?? document.body;
    fireEvent.contextMenu(space, { clientX: 50, clientY: 50 });
    fireEvent.click(screen.getByRole("menuitem", { name: "New shell here" }));
    if (mode === "filled") click(1);
    else send("tidy-tiles");
    await act(async () => {
      finish?.();
      await Promise.resolve();
    });
    expect(views.some((view) => view.open.mock.calls.some(([id]) => id === "home-created"))).toBe(
      true,
    );
    if (mode === "filled") expect(views[1]?.open).toHaveBeenLastCalledWith("build");
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

test("concurrent new shells use each request's identity and destination", async () => {
  const { screen, click, send, source, data, views } = setup();
  click(0);
  send("split-right");
  const first = screen.container.querySelector('[data-empty="true"]') ?? document.body;
  fireEvent.contextMenu(first);
  fireEvent.click(screen.getByRole("menuitem", { name: "Split down" }));
  const spaces = Array.from(screen.container.querySelectorAll('[data-empty="true"]'));
  const finish: ((value: { terminalId: string }) => void)[] = [];
  source.sidebarCommand = vi.fn(
    () =>
      new Promise<{ terminalId: string }>((resolve) => {
        finish.push(resolve);
      }),
  );
  for (const space of spaces) {
    fireEvent.contextMenu(space);
    fireEvent.click(screen.getByRole("menuitem", { name: "New shell here" }));
  }
  expect(finish).toHaveLength(2);
  await act(async () => {
    data.update("check", { id: "home-one", kind: "shell", home: true });
    data.update("build", { id: "home-two", kind: "shell", home: true });
    finish[1]?.({ terminalId: "home-two" });
    await Promise.resolve();
    finish[0]?.({ terminalId: "home-one" });
  });
  expect(spaces.every((space) => space.getAttribute("data-empty") === "false")).toBe(true);
  for (const [index, id] of ["home-one", "home-two"].entries()) {
    const view = views.find((view) =>
      view.mount.mock.calls.some(
        ([element]: unknown[]) => element instanceof Node && spaces[index]?.contains(element),
      ),
    );
    expect(view?.open).toHaveBeenLastCalledWith(id);
  }
});
