import { agent, mock, settle, verdict } from "./app-board-fixture";
// @vitest-environment jsdom
import { act, fireEvent, render, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { App } from "../../../../src/renderer/app";
import { createAppSource } from "../../../../src/renderer/board/live-board-source";
import { setupState } from "../../../fixtures/setup";
test("board starts empty, launches into a tile, and Settings keeps its view mounted", async () => {
  const screen = render(<App />);
  await settle();
  expect(screen.queryByRole("button", { name: "Preflight" })).toBeNull();
  expect(mock.create).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Local shell" })).toBeNull();
  expect(screen.queryByRole("button", { name: "New worktree" })).toBeNull();
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [agent("a")] });
  act(() => mock.changed?.());
  await settle();
  fireEvent.click(screen.getByRole("treeitem", { name: /Running/ }));
  await settle();
  expect(mock.open).toHaveBeenCalledWith("a");
  const tile = screen.getByRole("region", { name: "Tile 1: Claude Code" });
  fireEvent.keyDown(tile, { key: "Escape" });
  expect(mock.kill).not.toHaveBeenCalled();
  act(() => {
    mock.command?.("settings");
  });
  await settle();
  expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
  expect(mock.dispose).not.toHaveBeenCalled();
  const reads = mock.setupState.mock.calls.length;
  act(() => {
    mock.command?.("settings");
  });
  await settle();
  expect(mock.setupState.mock.calls.length).toBe(reads);
  fireEvent.keyDown(screen.getByRole("region", { name: "Settings" }), { key: "Escape" });
  await settle();
  expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
  expect(document.activeElement?.className).toBe("board-row");
  mock.setupState.mockRejectedValueOnce(new Error("gone"));
  fireEvent.click(screen.container.querySelector(".config-gear") ?? document.body);
  fireEvent.click(screen.getByRole("menuitem", { name: /^Settings/ }));
  await settle();
  expect(screen.getByRole("alert").textContent).toBe("Unable to open Settings.");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("dialog", { name: "Action failed" })).toBeNull();
});
test("feedback failure is visible and retry leaves main in charge of attention", async () => {
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [agent("a", verdict("a"))] });
  const screen = render(<App />);
  await settle();
  fireEvent.click(screen.getByRole("treeitem", { name: /Continue/ }));
  await settle();
  mock.feedback.mockRejectedValueOnce(new Error("disk full"));
  const dismiss = () => screen.getByRole("button", { name: "Dismiss incorrect attention flag" });
  expect(dismiss().textContent).toBe("Dismiss");
  expect(dismiss().title).toContain("false positive");
  fireEvent.click(dismiss());
  await settle();
  expect(screen.getByRole("alert").textContent).toContain("Unable to record feedback");
  fireEvent.click(dismiss());
  await settle();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(dismiss()).toBeTruthy();
});
test("unreadable settings fall back to the empty board; samples require the build flag", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.setupState.mockRejectedValue(new Error("gone"));
  const screen = render(<App />);
  await settle();
  expect(screen.getByRole("main", { name: "Board" })).toBeTruthy();
  expect(error).toHaveBeenCalled();
  screen.unmount();
  mock.setupState.mockResolvedValue(setupState({ setupComplete: true }));
  vi.stubGlobal("FOOM_SAMPLE_BOARD", true);
  const sample = render(<App />);
  await settle();
  expect(sample.container.querySelectorAll('[data-kind="sample"]')).toHaveLength(9);
  vi.unstubAllGlobals();
});
test("first run still performs setup before opening the board, without a Preflight footer button", async ({
  onTestFinished,
}) => {
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  window.desktop.checkReadiness = vi.fn(() =>
    Promise.resolve({
      git: "ready" as const,
      platform: "linux" as const,
      forges: [],
    }),
  );
  mock.setupState.mockResolvedValue(setupState());
  const screen = render(<App />);
  await settle();
  expect(screen.queryByRole("main", { name: "Board" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Start preflight" }));
  await settle();
  for (let step = 0; step < 2; step++) {
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
  }
  fireEvent.click(screen.getByRole("button", { name: "Launch" }));
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
  await settle();
  expect(screen.getByRole("main", { name: "Board" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Preflight" })).toBeNull();
});

test("main's cosmetic scrim follows visibility and unsubscribes when the app unmounts", async () => {
  const showPopover = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "showPopover", {
    configurable: true,
    value: showPopover,
  });
  let receive: (visible: boolean) => void = () => undefined;
  const off = vi.fn();
  Object.defineProperty(window.desktop, "confirmations", {
    configurable: true,
    value: {
      onScrim(callback: (visible: boolean) => void) {
        receive = callback;
        return off;
      },
    },
  });
  const view = render(<App />);
  await settle();
  const input = document.createElement("textarea");
  view.container.append(input);
  input.focus();
  // The board may process preparation and cancellation in one React batch.
  act(() => {
    receive(true);
    receive(false);
    input.blur();
  });
  expect(document.activeElement).toBe(input);
  act(() => {
    receive(false);
    receive(true);
    receive(true);
  });
  input.blur();
  act(() => {
    receive(false);
    receive(true);
  });
  expect(showPopover).toHaveBeenCalledOnce();
  expect(
    view.container.querySelector(".board-confirmation-scrim")?.getAttribute("aria-hidden"),
  ).toBe("true");
  act(() => {
    receive(false);
    // Native popover dismissal can clear focus before React commits removal.
    input.blur();
  });
  expect(view.container.querySelector(".board-confirmation-scrim")).toBeNull();
  expect(document.activeElement).toBe(input);
  act(() => {
    receive(true);
  });
  act(() => {
    receive(false);
  });
  const other = document.createElement("button");
  view.container.append(other);
  other.focus();
  expect(document.activeElement).toBe(other);
  expect(showPopover).toHaveBeenCalled();
  view.unmount();
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  expect(off).toHaveBeenCalledOnce();
});
test("live preview arrivals refresh main-owned inventory before asking the board to place", async () => {
  let listener:
    | ((id: string, expiresAt: number) => Promise<"landing" | "empty" | "sidebar">)
    | undefined;
  const close = vi.fn(() => Promise.resolve());
  const off = vi.fn();
  Object.defineProperty(window.desktop, "previews", {
    configurable: true,
    value: {
      close,
      onPlace: (callback: typeof listener) => {
        listener = callback;
        return off;
      },
    },
  });
  const inventory = vi.spyOn(window.desktop, "sidebarInventory").mockResolvedValue({
    repositories: [],
    shell: "bash",
    previewActions: [{ id: "open", terminalId: "agent", path: "plan.md", at: 100 }],
    previews: [
      {
        id: "preview",
        openedBy: { terminalId: "agent", agent: "claude" },
        relativePath: "plan.md",
        kind: "markdown",
        repository: "/repo",
        worktree: "/tree",
        network: false,
      },
    ],
  });
  const source = createAppSource();
  expect(source.previews?.getHistory?.()).toEqual([]);
  const callback = vi.fn(() => Promise.resolve("empty" as const));
  const dispose = source.previews?.onPlace?.(callback);
  if (!listener || !dispose) throw new Error("Missing preview arrival");
  expect(await listener("preview", 1234)).toBe("empty");
  expect(inventory).toHaveBeenCalled();
  expect(source.previews?.getSnapshot()).toMatchObject([{ id: "preview" }]);
  expect(source.previews?.getHistory?.()).toEqual([
    { id: "open", terminalId: "agent", path: "plan.md", at: 100 },
  ]);
  expect(source.previews?.getSnapshot()[0]?.openedBy).toEqual({
    terminalId: "agent",
    agent: "claude",
  });
  expect(callback).toHaveBeenCalledWith("preview", 1234);
  await source.previews?.close("preview");
  expect(close).toHaveBeenCalledWith("preview");
  dispose();
  expect(off).toHaveBeenCalled();
  delete window.desktop.previews;
});

test("the application owns and disposes preview composition independently of tile mounting", async () => {
  const off = vi.fn();
  const cover = vi.fn(() => Promise.resolve());
  const onSnapshots = vi.fn(() => off);
  window.desktop.previews = {
    reload: vi.fn(async () => {}),
    popout: vi.fn(),
    pick: vi.fn(),
    network: vi.fn(),
    close: vi.fn(),
    bounds: vi.fn(),
    painted: vi.fn(async () => {}),
    cover,
    onSnapshots,
  };
  Object.defineProperty(document, "getAnimations", { configurable: true, value: () => [] });
  const screen = render(<App />);
  await act(async () => {});
  expect(onSnapshots).toHaveBeenCalled();
  screen.unmount();
  expect(off).toHaveBeenCalled();
  expect(cover).toHaveBeenCalledWith(false);
  delete window.desktop.previews;
  Reflect.deleteProperty(document, "getAnimations");
});

test.each([
  ["licenses", "Licenses"],
  ["notices", "Third-party notices"],
] as const)("application re-presents %s above About on every request", async (id, title) => {
  const shown = vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute("open", "");
  });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.removeAttribute("open");
  });
  let receive: (id: "licenses" | "notices") => void = () => {};
  const off = vi.fn();
  vi.mocked(window.desktop.appMenu.onLegal).mockImplementation((callback) => {
    receive = callback;
    return off;
  });
  const commands = new Set<Parameters<typeof window.desktop.onBoardCommand>[0]>();
  vi.spyOn(window.desktop, "onBoardCommand").mockImplementation((listener) => {
    commands.add(listener);
    return () => {
      commands.delete(listener);
    };
  });
  vi.mocked(window.desktop.appMenu.version).mockResolvedValue({ app: "1", electron: "1" });
  const view = render(<App />);
  await settle();
  act(() => {
    receive(id);
  });
  await settle();
  const first = view.getByRole("dialog", { name: title });
  act(() => {
    for (const command of commands) command("about");
  });
  await settle();
  const about = view.getByRole("dialog", { name: "About Foom" });
  expect(shown.mock.contexts.at(-1)).toBe(about);
  vi.mocked(window.desktop.appMenu.execute).mockImplementation(() => {
    receive(id);
    return Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: title }));
  await settle();
  const reopened = view.getByRole("dialog", { name: title });
  expect(reopened).not.toBe(first);
  expect(shown.mock.contexts.at(-1)).toBe(reopened);
  expect(view.getByText("Bundled legal text")).toBeTruthy();
  fireEvent.click(within(reopened).getByRole("button", { name: "Close" }));
  expect(view.queryByRole("dialog", { name: title })).toBeNull();
  expect(view.getByRole("dialog", { name: "About Foom" })).toBe(about);
  view.unmount();
  expect(off).toHaveBeenCalledOnce();
});

test("Settings queues terminal input focus after reattaching its original xterm", async () => {
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [agent("a")] });
  const screen = render(<App />);
  await settle();
  fireEvent.click(screen.getByRole("treeitem", { name: /Running/ }));
  await settle();
  const input = document.createElement("textarea");
  input.className = "xterm-helper-textarea";
  screen.container.querySelector(".tile-terminal")?.append(input);
  act(() => {
    input.focus();
  });
  act(() => mock.command?.("settings"));
  await settle();
  input.hidden = true;
  mock.focus.mockClear();
  fireEvent.keyDown(screen.getByRole("region", { name: "Settings" }), { key: "Escape" });
  await settle();
  expect(mock.focus).toHaveBeenCalledOnce();
  // Reopen while the asynchronous view would still be hidden, then finish it.
  act(() => mock.command?.("settings"));
  await settle();
  input.hidden = false;
  fireEvent.keyDown(screen.getByRole("region", { name: "Settings" }), { key: "Escape" });
  await settle();
  expect(document.activeElement).toBe(input);
});
