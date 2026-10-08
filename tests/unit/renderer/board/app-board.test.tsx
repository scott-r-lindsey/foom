// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BoardCommand } from "../../../../src/shared/board-command";
import type { TerminalActivity } from "../../../../src/shared/desktop";
import type { TerminalState, WorkspaceSnapshot } from "../../../../src/shared/workspace";
import type { SetupState } from "../../../../src/shared/setup";
import { createAppSource } from "../../../../src/renderer/board/live-board-source";
import { App } from "../../../../src/renderer/app";
import { installation, report, setupState } from "../../../fixtures/setup";
const mock = vi.hoisted(() => ({
  command: undefined as ((command: BoardCommand) => void) | undefined,
  state: undefined as ((state: TerminalState) => void) | undefined,
  changed: undefined as (() => void) | undefined,
  exit: undefined as ((id: string, code: number) => void) | undefined,
  activity: undefined as ((batch: TerminalActivity[]) => void) | undefined,
  workspace: vi.fn<() => Promise<WorkspaceSnapshot>>(),
  create: vi.fn<() => Promise<{ id: string; title: string }>>(),
  kill: vi.fn(),
  feedback: vi.fn(),
  tail: vi.fn(),
  startWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  addRepository: vi.fn(),
  sidebarCommand: vi.fn(),
  off: vi.fn(),
  setupState: vi.fn<() => Promise<SetupState>>(),
  mount: vi.fn(),
  dispose: vi.fn(),
  open: vi.fn(),
  hide: vi.fn(),
  focus: vi.fn(),
}));
vi.mock("../../../../src/renderer/terminal/terminal-view-source", () => ({
  createTerminalView: () => ({
    mount: (element: HTMLElement) => {
      mock.mount(element);
      return mock.dispose;
    },
    open: mock.open,
    hide: mock.hide,
    focus: mock.focus,
    subscribe: () => () => {},
    getSnapshot: () => terminalView,
  }),
}));
const terminalView = {
  status: "Terminal",
  state: "quiet_ok",
  visible: false,
  toggleLabel: "Open terminal",
  toggleDisabled: true,
  restartDisabled: true,
};
vi.mock("../../../../src/renderer/preflight/scale-preflight", () => ({ scalePreflight: vi.fn() }));
vi.mock("../../../../src/renderer/preflight/center-step", () => ({ centerStep: vi.fn() }));
const agent = (id: string, state: TerminalState | null = null) => ({
  id,
  kind: "agent" as const,
  agent: "claude" as const,
  repository: "/code/app",
  worktree: `/code/${id}`,
  branch: id,
  attention: "hooks" as const,
  state,
});
const verdict = (id: string, timestamp = 100): TerminalState => ({
  id,
  state: "needs_input",
  verdictId: `v-${String(timestamp)}`,
  timestamp,
  reason: "Continue?",
  signal: "pattern:confirmation",
  confidence: 1,
});
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.useFakeTimers();
  mock.create.mockResolvedValue({ id: "real-id", title: "bash" });
  mock.open.mockResolvedValue(undefined);
  mock.hide.mockResolvedValue(undefined);
  mock.workspace.mockResolvedValue({
    repositories: [{ path: "/code/app", name: "app" }],
    terminals: [],
  });
  mock.setupState.mockResolvedValue(setupState({ setupComplete: true }));
  mock.tail.mockResolvedValue(["real output"]);
  mock.feedback.mockResolvedValue(undefined);
  mock.removeWorktree.mockResolvedValue(true);
  mock.addRepository.mockResolvedValue(null);
  mock.sidebarCommand.mockResolvedValue(undefined);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  });
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      setupState: mock.setupState,
      onSetupChange: () => () => {},
      codeSuggestions: () => Promise.resolve([]),
      saveSetup: (patch: Partial<SetupState["settings"]>) =>
        Promise.resolve(setupState({ ...patch, setupComplete: true })),
      scanAgents: () =>
        Promise.resolve(report(installation("claude"), installation("codex"), installation("agy"))),
      sidebarInventory: () => Promise.resolve({ repositories: [], shell: "bash" }),
      sidebarCommand: mock.sidebarCommand,
      workspace: mock.workspace,
      create: mock.create,
      kill: mock.kill,
      feedback: mock.feedback,
      tail: mock.tail,
      startWorktree: mock.startWorktree,
      removeWorktree: mock.removeWorktree,
      addRepository: mock.addRepository,
      onBoardCommand: (listener: (command: BoardCommand) => void) => {
        mock.command = listener;
        return () => {
          mock.command = undefined;
        };
      },
      onWorkspaceChange: (listener: () => void) => {
        mock.changed = listener;
        return mock.off;
      },
      onState: (listener: (state: TerminalState) => void) => {
        mock.state = listener;
        return mock.off;
      },
      onExit: (listener: (id: string, code: number) => void) => {
        mock.exit = listener;
        return mock.off;
      },
      onActivity: (listener: (batch: TerminalActivity[]) => void) => {
        mock.activity = listener;
        return mock.off;
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
test("source connects independently of views, reconciles events, preserves ordering, and keeps activity outside snapshots", async () => {
  const source = createAppSource();
  expect(source.isReady?.()).toBe(false);
  const disconnect = source.connect?.();
  await settle();
  expect(source.isReady?.()).toBe(true);
  await source.shell?.restart();
  expect(source.getSnapshot()[0]?.id).toBe("real-id");
  const listener = vi.fn(),
    off = source.subscribe(listener),
    activity = vi.fn(),
    offActivity = source.subscribeActivity(activity);
  const before = source.getSnapshot();
  mock.activity?.([{ id: "real-id", rate: 2000 }]);
  expect(source.getSnapshot()).toBe(before);
  expect(listener).not.toHaveBeenCalled();
  expect(activity).toHaveBeenCalledOnce();
  mock.state?.(verdict("a"));
  mock.workspace.mockResolvedValue({
    repositories: [{ path: "/code/app", name: "app" }],
    terminals: [agent("a")],
  });
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()[1]).toMatchObject({
    id: "a",
    repository: "app",
    waitingSince: 100,
    state: "needs_input",
  });
  source.markSeen("a");
  mock.state?.(verdict("a", 200));
  expect(source.getSnapshot()[1]?.waitingSince).toBe(100);
  await source.resolve("a", "Not attention");
  expect(mock.feedback).toHaveBeenCalledWith("a", "v-200", "dismissed");
  mock.state?.({ ...verdict("a", 300), state: "quiet_ok", verdictId: null });
  expect(source.getSnapshot()[1]?.waitingSince).toBe(0);
  await source.resolve("a", "ignored");
  await source.resolve("foreign", "ignored");
  expect(mock.feedback).toHaveBeenCalledOnce();
  mock.state?.({ ...verdict("a", 400), verdictId: null });
  await source.resolve("a", "Not attention");
  expect(mock.feedback).toHaveBeenLastCalledWith("a", null, "dismissed");
  await expect(source.tail("foreign")).resolves.toEqual([]);
  await expect(source.tail("local-shell")).resolves.toEqual([]);
  await expect(source.tail("a")).resolves.toEqual(["real output"]);
  mock.exit?.("a", 1);
  mock.state?.(verdict("a", 500));
  expect(source.getSnapshot()[1]?.state).toBe("failed");
  mock.state?.({ ...verdict("a", 600), state: "failed" });
  source.markSeen("a");
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [agent("b", { ...verdict("b"), state: "done" }), agent("a")],
  });
  mock.changed?.();
  await settle();
  expect(source.getSnapshot().map((row) => row.id)).toEqual(["real-id", "a", "b"]);
  expect(source.getSnapshot()[1]?.seen).toBe(true);
  mock.exit?.("real-id", 0);
  expect(source.getSnapshot()[0]?.state).toBe("done");
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [] });
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()).toHaveLength(1);
  expect(source.getRepositories?.()).toEqual([]);
  expect(source.getSidebar?.()).toEqual([]);
  expect(source.shellName?.()).toBe("bash");
  off();
  offActivity();
  disconnect?.();
  expect(mock.off).toHaveBeenCalledTimes(4);
});
test("late snapshots and disconnected refreshes cannot undo newer inventory or verdicts", async () => {
  const source = createAppSource();
  let finish: ((value: WorkspaceSnapshot) => void) | undefined;
  mock.workspace.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const off = source.connect?.();
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [agent("new", verdict("new", 200))],
  });
  mock.changed?.();
  await settle();
  finish?.({ repositories: [], terminals: [agent("old")] });
  await settle();
  expect(source.getSnapshot()[0]?.id).toBe("new");
  mock.state?.(verdict("new", 300));
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()[0]?.verdictId).toBe("v-300");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.workspace.mockRejectedValueOnce(new Error("offline"));
  mock.changed?.();
  await settle();
  expect(error).toHaveBeenCalled();
  mock.workspace.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mock.changed?.();
  off?.();
  finish?.({ repositories: [], terminals: [] });
  await settle();
  expect(source.getSnapshot()).toHaveLength(1);
});
test("explicit shell launch serializes duplicate requests and keeps failures retryable", async () => {
  const source = createAppSource();
  mock.create.mockRejectedValueOnce(new Error("no PTY"));
  await source.shell?.restart();
  expect(source.getSnapshot()[0]).toMatchObject({
    id: "local-shell",
    state: "failed",
    exited: true,
  });
  await source.sidebarCommand?.({ kind: "restart", id: "local-shell" });
  expect(source.getSnapshot()[0]?.id).toBe("real-id");
  await Promise.all([source.shell?.restart(), source.shell?.restart()]);
  expect(mock.kill).toHaveBeenCalledWith("real-id");
  expect(mock.create).toHaveBeenCalledTimes(3);
  mock.create.mockRejectedValueOnce("offline");
  await source.shell?.restart();
  expect(source.getSnapshot()[0]?.reason).toContain("offline");
  const kills = mock.kill.mock.calls.length;
  await source.shell?.restart();
  expect(source.getSnapshot()[0]?.id).toBe("real-id");
  expect(mock.kill).toHaveBeenCalledTimes(kills);
});
test("launch, close and worktree actions refresh their inventories", async () => {
  const source = createAppSource();
  expect(await source.worktrees?.load()).toMatchObject({ hooks: true, acknowledged: false });
  expect(await source.worktrees?.addRepository()).toBeNull();
  const request = {
    repository: "/r",
    branch: "feature",
    run: "shell" as const,
    acknowledgeCodexNotifierReplacement: false,
  };
  await source.worktrees?.start(request);
  expect(mock.startWorktree).toHaveBeenCalledWith(request);
  mock.removeWorktree.mockResolvedValueOnce(false);
  expect(await source.worktrees?.remove("a")).toBe(false);
  expect(await source.worktrees?.remove("a")).toBe(true);
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [agent("a")] });
  await source.sidebarCommand?.({ kind: "launch", repository: "/r", worktree: "/r", run: "shell" });
  expect(source.getSnapshot()).toHaveLength(1);
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [] });
  await source.sidebarCommand?.({ kind: "close", id: "a" });
  expect(source.getSnapshot()).toHaveLength(0);
});
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
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.setupState.mockRejectedValueOnce(new Error("gone"));
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await settle();
  expect(error).toHaveBeenCalledWith("Unable to load setup:", expect.any(Error));
});
test("feedback failure is visible and retry leaves main in charge of attention", async () => {
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [agent("a", verdict("a"))] });
  const screen = render(<App />);
  await settle();
  fireEvent.click(screen.getByRole("treeitem", { name: /Continue/ }));
  await settle();
  mock.feedback.mockRejectedValueOnce(new Error("disk full"));
  fireEvent.click(screen.getByRole("button", { name: "Not attention" }));
  await settle();
  expect(screen.getByRole("alert").textContent).toContain("Unable to record feedback");
  fireEvent.click(screen.getByRole("button", { name: "Not attention" }));
  await settle();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Not attention" })).toBeTruthy();
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
  expect(sample.container.querySelectorAll('[data-kind="sample"]')).toHaveLength(10);
  vi.unstubAllGlobals();
});
test("first run still performs setup before opening the board, without a Preflight footer button", async () => {
  mock.setupState.mockResolvedValue(setupState());
  const screen = render(<App />);
  await settle();
  expect(screen.queryByRole("main", { name: "Board" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Start preflight" }));
  await settle();
  for (let step = 0; step < 4; step++) {
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

test("closing a local shell forgets its revoked ID and placeholder rows never attach", async () => {
  const source = createAppSource();
  const view = source.createView?.();
  await view?.open("foreign");
  expect(mock.hide).toHaveBeenCalled();
  mock.create.mockRejectedValueOnce(new Error("unavailable"));
  await source.shell?.restart();
  await view?.open("local-shell");
  expect(mock.open).not.toHaveBeenCalled();
  await source.sidebarCommand?.({ kind: "close", id: "local-shell" });
  expect(mock.sidebarCommand).not.toHaveBeenCalled();
  expect(source.getSnapshot()).toHaveLength(0);
  await source.shell?.restart();
  await view?.open("real-id");
  expect(mock.open).toHaveBeenCalledWith("real-id");
  await source.sidebarCommand?.({ kind: "close", id: "real-id" });
  await source.shell?.restart();
  expect(mock.kill).not.toHaveBeenCalled();
});

test("inventory refresh marks missing checkout sessions without losing state or views and clears the mark on return", async () => {
  const entry = agent("external", verdict("external"));
  const repository = { path: entry.repository, name: "app" };
  const tree = {
    path: entry.worktree,
    branch: "external",
    head: "abc",
    bare: false,
    locked: false,
    prunable: false,
    managed: false,
  };
  const inventory = vi
    .spyOn(window.desktop, "sidebarInventory")
    .mockResolvedValue({ repositories: [{ ...repository, worktrees: [tree] }], shell: "bash" });
  mock.workspace.mockResolvedValue({ repositories: [repository], terminals: [entry] });
  const source = createAppSource();
  const disconnect = source.connect?.();
  await settle();
  expect(source.getSnapshot()[0]?.worktreeRemoved).toBe(false);
  inventory.mockResolvedValue({ repositories: [{ ...repository, worktrees: [] }], shell: "bash" });
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()[0]).toMatchObject({
    id: entry.id,
    worktreeRemoved: true,
    state: "needs_input",
  });
  expect(mock.kill).not.toHaveBeenCalled();
  expect(mock.hide).not.toHaveBeenCalled();
  inventory.mockResolvedValue({
    repositories: [{ ...repository, worktrees: [tree] }],
    shell: "bash",
  });
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()[0]?.worktreeRemoved).toBe(false);
  disconnect?.();
});
