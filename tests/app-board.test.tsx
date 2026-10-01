// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ShellView } from "../src/renderer/shell.d";
import type { TerminalActivity } from "../src/shared/desktop";
import { createAppSource } from "../src/renderer/app-source";
import { Shell } from "../src/renderer/shell";
import { installation, report, setupState } from "./fixtures/setup";
import type { TerminalState, WorkspaceSnapshot } from "../src/shared/workspace";
import type { SetupState } from "../src/shared/setup";
const mock = vi.hoisted(() => ({
  failStart: false,
  created: undefined as ((id: string, title: string) => void) | undefined,
  state: undefined as ((state: TerminalState) => void) | undefined,
  changed: undefined as (() => void) | undefined,
  exit: undefined as ((id: string, code: number) => void) | undefined,
  workspace: vi.fn<() => Promise<WorkspaceSnapshot>>(),
  feedback: vi.fn(),
  update: undefined as ((view: ShellView) => void) | undefined,
  escape: undefined as (() => void) | undefined,
  activity: undefined as ((batch: TerminalActivity[]) => void) | undefined,
  open: vi.fn<() => Promise<void>>(),
  toggle: vi.fn<() => Promise<void>>(),
  hide: vi.fn<() => Promise<void>>(),
  restart: vi.fn<() => Promise<void>>(),
  dispose: vi.fn(),
  tail: vi.fn<() => Promise<string[]>>(),
  owns: vi.fn<(id: string) => boolean>(),
  off: vi.fn(),
  setupState: vi.fn<() => Promise<SetupState>>(),
}));
vi.mock("../src/renderer/shell-controller", () => ({
  createShell: (
    _element: HTMLElement,
    update: (view: ShellView) => void,
    _visible: boolean,
    escape: () => void,
    created: (id: string, title: string) => void,
  ) => {
    mock.created = created;
    if (mock.failStart)
      update({ ...view, state: "failed", status: "Unable to start shell", restartDisabled: false });
    else created("real-id", "bash");
    mock.update = update;
    mock.escape = escape;
    return mock;
  },
}));
const view: ShellView = {
  status: "bash",
  state: "quiet_ok",
  toggleLabel: "Open terminal",
  visible: false,
  toggleDisabled: false,
  restartDisabled: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  mock.failStart = false;
  vi.useFakeTimers();
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      setupState: mock.setupState,
      onSetupChange: () => () => undefined,
      codeSuggestions: () => Promise.resolve([]),
      saveSetup: (patch: Partial<SetupState["settings"]>) =>
        Promise.resolve(setupState({ ...patch, setupComplete: true })),
      scanAgents: () =>
        Promise.resolve(report(installation("claude"), installation("codex"), installation("agy"))),
      workspace: mock.workspace,
      tail: mock.tail,
      feedback: mock.feedback,
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
  mock.workspace.mockResolvedValue({
    repositories: [{ path: "/code/app", name: "app" }],
    terminals: [],
  });
  mock.feedback.mockResolvedValue(undefined);
  mock.tail.mockResolvedValue(["real output"]);
  mock.update = undefined;
  mock.setupState.mockResolvedValue(setupState({ setupComplete: true }));
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: true }),
  });
  mock.owns.mockImplementation((id) => id === "real-id");
  mock.toggle.mockImplementation(async () => {
    await Promise.resolve();
    mock.update?.({ ...view, visible: true, toggleLabel: "Hide terminal" });
  });
  mock.open.mockImplementation(mock.toggle);
  mock.hide.mockResolvedValue();
  mock.restart.mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

test("live source reconciles events, snapshots, tails and feedback without publishing activity", async () => {
  const source = createAppSource();
  const shell = source.shell;
  if (!shell) throw new Error("Missing shell");
  await shell.toggle();
  await shell.open();
  await shell.restart();
  await shell.hide();
  await expect(source.tail("foreign")).resolves.toEqual([]);
  const dispose = shell.mount(document.createElement("div"), vi.fn());
  await Promise.resolve();
  expect(source.getSnapshot().map((row) => row.id)).toEqual(["real-id"]);
  const listener = vi.fn();
  const off = source.subscribe(listener);
  const viewListener = vi.fn();
  const offView = shell.subscribe(viewListener);
  mock.update?.(view);
  expect(shell.getSnapshot()).toEqual(view);
  expect(viewListener).toHaveBeenCalledOnce();
  const activity = vi.fn();
  const offActivity = source.subscribeActivity(activity);
  const before = source.getSnapshot();
  mock.activity?.([{ id: "real-id", rate: 2000 }]);
  expect(source.getSnapshot()).toBe(before);
  expect(listener).not.toHaveBeenCalled();
  expect(activity).toHaveBeenCalledWith([{ id: "real-id", rate: 2000 }]);
  mock.state?.(verdict("a"));
  mock.workspace.mockResolvedValue({
    repositories: [{ path: "/code/app", name: "app" }],
    terminals: [agent("a")],
  });
  mock.changed?.();
  await Promise.resolve();
  expect(source.getSnapshot()[1]).toMatchObject({
    id: "a",
    repository: "app",
    state: "needs_input",
    waitingSince: 100,
  });
  source.markSeen("a");
  await shell.open("a");
  expect(mock.open).toHaveBeenCalledWith("a");
  expect(source.getSnapshot()[1]?.state).toBe("needs_input");
  expect(mock.feedback).not.toHaveBeenCalled();
  mock.state?.(verdict("a", 200));
  expect(source.getSnapshot()[1]?.waitingSince).toBe(100);
  await source.resolve("a", "Not attention");
  expect(mock.feedback).toHaveBeenCalledWith("a", "v-200", "dismissed");
  mock.state?.({
    ...verdict("a", 300),
    state: "quiet_ok",
    signal: "user:dismissed",
    verdictId: null,
  });
  expect(source.getSnapshot()[1]?.waitingSince).toBe(0);
  await source.resolve("a", "Not attention");
  await source.resolve("foreign", "Not attention");
  expect(mock.feedback).toHaveBeenCalledOnce();
  mock.state?.({ ...verdict("a", 400), verdictId: null });
  await source.resolve("a", "Not attention");
  expect(mock.feedback).toHaveBeenLastCalledWith("a", null, "dismissed");
  await expect(source.tail("a")).resolves.toEqual(["real output"]);
  expect(mock.tail).toHaveBeenCalledWith("a", 40);
  mock.exit?.("a", 1);
  expect(source.getSnapshot()[1]).toMatchObject({ state: "failed", waitingSince: 0 });
  mock.state?.(verdict("a", 500));
  expect(source.getSnapshot()[1]?.state).toBe("failed");
  mock.state?.({ ...verdict("a", 600), state: "failed" });
  source.markSeen("a");
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [agent("b", { ...verdict("b"), state: "done" }), agent("a")],
  });
  mock.changed?.();
  await Promise.resolve();
  expect(source.getSnapshot().map((row) => row.id)).toEqual(["real-id", "a", "b"]);
  expect(source.getSnapshot()[1]?.seen).toBe(true);
  mock.exit?.("real-id", 0);
  expect(source.getSnapshot()[0]?.state).toBe("done");
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [] });
  mock.changed?.();
  await Promise.resolve();
  expect(source.getSnapshot()).toHaveLength(1);
  await shell.toggle();
  await shell.hide();
  await shell.restart();
  off();
  offView();
  offActivity();
  dispose();
  expect(mock.dispose).toHaveBeenCalledOnce();
  expect(mock.off).toHaveBeenCalledTimes(4);
});

test("snapshot loading cannot overwrite newer events or revive a disposed source", async () => {
  const source = createAppSource();
  let finish: (snapshot: WorkspaceSnapshot) => void = () => {};
  mock.workspace.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const dispose = source.shell?.mount(document.createElement("div"), vi.fn());
  mock.state?.(verdict("a", 200));
  finish({ repositories: [], terminals: [{ ...agent("a", verdict("a", 100)), branch: null }] });
  await Promise.resolve();
  expect(source.getSnapshot()[1]).toMatchObject({ waitingSince: 200, branch: "Detached HEAD" });
  mock.workspace.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mock.changed?.();
  mock.changed?.();
  await Promise.resolve();
  finish({ repositories: [], terminals: [agent("stale")] });
  await Promise.resolve();
  expect(source.getSnapshot().some((row) => row.id === "stale")).toBe(false);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.workspace.mockRejectedValueOnce(new Error("gone"));
  mock.changed?.();
  await Promise.resolve();
  expect(error).toHaveBeenCalled();
  mock.workspace.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  mock.changed?.();
  dispose?.();
  finish({ repositories: [], terminals: [agent("late")] });
  await Promise.resolve();
  expect(source.getSnapshot().some((row) => row.id === "late")).toBe(false);
});

test("board starts hidden, opens the shell, preserves printable keys and returns focus on Escape", async () => {
  const screen = render(<Shell />);
  // Setup already ran, so the board appears once main's settings arrive.
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    mock.update?.(view);
  });
  const row = screen.container.querySelector<HTMLButtonElement>('[data-kind="shell"]');
  expect(mock.toggle).not.toHaveBeenCalled();
  await act(async () => {
    row?.click();
    await Promise.resolve();
  });
  expect(mock.toggle).toHaveBeenCalledOnce();
  const panel = screen.container.querySelector(".board-terminal");
  if (!panel) throw new Error("Missing panel");
  fireEvent.keyDown(panel, { key: "n" });
  expect(screen.container.querySelector(".terminal-title h2")?.textContent).toBe("Shell · Shell");
  act(() => {
    mock.escape?.();
  });
  expect(document.activeElement).toBe(row);
  expect(mock.hide).toHaveBeenCalledOnce();
  act(() => {
    mock.update?.(view);
  });
  await act(async () => {
    row?.click();
    await Promise.resolve();
  });
  act(() => {
    screen.getByRole("button", { name: "Hide terminal" }).click();
  });
  expect(document.activeElement).toBe(row);
  act(() => {
    mock.update?.({ ...view, restartDisabled: false });
    row?.click();
  });
  act(() => {
    screen.getByRole("button", { name: "Restart shell" }).click();
  });
  expect(mock.restart).toHaveBeenCalledOnce();
  act(() => {
    mock.update?.(view);
  });
  await act(async () => {
    screen.getByRole("button", { name: "Open terminal" }).click();
    await Promise.resolve();
  });
  expect(mock.toggle).toHaveBeenCalledTimes(5);
});

async function settle() {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}

test("first run shows preflight, then launches into the board", async () => {
  mock.setupState.mockResolvedValue(setupState());
  const screen = render(<Shell />);
  await settle();
  expect(screen.container.querySelector(".board-home")).toBeNull();
  // The shell doesn't start until the board mounts.
  expect(mock.update).toBeUndefined();
  screen.getByRole("button", { name: "Start preflight" }).click();
  await settle();
  for (let step = 0; step < 4; step++) {
    act(() => {
      screen.getByRole("button", { name: "Continue" }).click();
    });
  }
  await settle();
  expect(screen.getByText("All stations go.")).toBeTruthy();
  act(() => {
    screen.getByRole("button", { name: "Launch" }).click();
  });
  await settle();
  // Reduced motion: the still launch frame ends on its own.
  await settle();
  expect(screen.container.querySelector(".preflight")).toBeNull();
  expect(screen.container.querySelector('[data-kind="shell"]')).toBeTruthy();
  expect(screen.getByRole("button", { name: "Preflight" })).toBeTruthy();
});

test("Preflight reopens over the board and Escape returns to the same row", async () => {
  const screen = render(<Shell />);
  await settle();
  act(() => {
    mock.update?.(view);
  });
  const row = screen.container.querySelector<HTMLButtonElement>('[data-kind="shell"]');
  await act(async () => {
    row?.click();
    await Promise.resolve();
  });
  await act(async () => {
    screen.getByRole("button", { name: "Preflight" }).click();
    await Promise.resolve();
  });
  // An open terminal is hidden first; the board stays mounted underneath.
  expect(mock.hide).toHaveBeenCalledOnce();
  expect(mock.dispose).not.toHaveBeenCalled();
  expect(screen.container.querySelector<HTMLElement>(".board-home")?.hidden).toBe(true);
  expect(screen.getByRole("button", { name: /Go \/ no-go/ })).toHaveProperty("disabled", false);
  fireEvent.keyDown(screen.container.querySelector(".preflight") as Element, { key: "Escape" });
  expect(screen.container.querySelector(".preflight")).toBeNull();
  expect(screen.container.querySelector<HTMLElement>(".board-home")?.hidden).toBe(false);
  expect(document.activeElement).toBe(row);

  // Preflight that can't load its state stays closed.
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.setupState.mockRejectedValueOnce(new Error("gone"));
  await act(async () => {
    screen.getByRole("button", { name: "Preflight" }).click();
    await Promise.resolve();
  });
  expect(screen.container.querySelector(".preflight")).toBeNull();
  expect(error).toHaveBeenCalledWith("Unable to load setup:", expect.any(Error));
});

test("unreadable settings fall back to the board", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  mock.setupState.mockRejectedValue(new Error("gone"));
  const screen = render(<Shell />);
  await settle();
  expect(screen.container.querySelector('[data-kind="shell"]')).toBeTruthy();
  expect(error).toHaveBeenCalledWith("Unable to load setup:", expect.any(Error));
});

test("sample sessions require the explicit development flag", async () => {
  vi.stubGlobal("FOOM_SAMPLE_BOARD", true);
  try {
    const screen = render(<Shell />);
    await settle();
    expect(screen.container.querySelectorAll('[data-kind="sample"]')).toHaveLength(10);
    expect(mock.update).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("a dismissal failure is visible and can be retried without clearing attention", async () => {
  const screen = render(<Shell />);
  await settle();
  act(() => {
    mock.state?.(verdict("real-id"));
  });
  await act(async () => {
    screen.container.querySelector<HTMLButtonElement>(".board-row")?.click();
    await Promise.resolve();
  });
  mock.feedback.mockRejectedValueOnce(new Error("disk full"));
  await act(async () => {
    screen.getByRole("button", { name: "Not attention" }).click();
    await Promise.resolve();
  });
  expect(screen.getByRole("alert").textContent).toContain("Unable to record feedback");
  expect(screen.container.querySelector(".board-row")?.getAttribute("data-state")).toBe(
    "needs_input",
  );
  await act(async () => {
    screen.getByRole("button", { name: "Not attention" }).click();
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a shell startup failure remains reachable for retry without sending a placeholder ID", async () => {
  mock.failStart = true;
  const source = createAppSource();
  await expect(source.tail("local-shell")).resolves.toEqual([]);
  const dispose = source.shell?.mount(document.createElement("div"), vi.fn());
  await Promise.resolve();
  expect(source.getSnapshot()[0]).toMatchObject({
    state: "failed",
    reason: "Unable to start shell",
  });
  await source.shell?.open("local-shell");
  expect(mock.open).toHaveBeenCalledWith(undefined);
  dispose?.();
});

test("an open startup row follows the shell's real ID when creation finishes", async () => {
  mock.failStart = true;
  const screen = render(<Shell />);
  await settle();
  await act(async () => {
    screen.container.querySelector<HTMLButtonElement>(".board-row")?.click();
    await Promise.resolve();
  });
  await act(async () => {
    mock.created?.("replacement", "bash");
    mock.update?.(view);
    await Promise.resolve();
  });
  expect(mock.open).toHaveBeenLastCalledWith("replacement");
  expect(screen.container.querySelector<HTMLElement>(".board-terminal")?.hidden).toBe(false);
});
