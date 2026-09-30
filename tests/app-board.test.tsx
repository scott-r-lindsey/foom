// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ShellView } from "../src/renderer/shell.d";
import type { TerminalActivity } from "../src/shared/desktop";
import { createAppSource } from "../src/renderer/app-source";
import { Shell } from "../src/renderer/shell";
import { installation, report, setupState } from "./fixtures/setup";
import type { SetupState } from "../src/shared/setup";
const mock = vi.hoisted(() => ({
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
  ) => {
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
  vi.useFakeTimers();
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      setupState: mock.setupState,
      onSetupChange: () => () => undefined,
      saveSetup: (patch: Partial<SetupState["settings"]>) =>
        Promise.resolve(setupState({ ...patch, setupComplete: true })),
      scanAgents: () =>
        Promise.resolve(report(installation("claude"), installation("codex"), installation("agy"))),
      workspace: () =>
        Promise.resolve({ repositories: [{ path: "/code/app", name: "app" }], terminals: [] }),
      onActivity: (listener: (batch: TerminalActivity[]) => void) => {
        mock.activity = listener;
        return mock.off;
      },
    },
  });
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

test("shell source routes only its live ID and disposes telemetry and simulation", async () => {
  const source = createAppSource();
  const shell = source.shell;
  if (!shell) throw new Error("Missing shell");
  await shell.toggle();
  await shell.open();
  await shell.restart();
  await shell.hide();
  expect(mock.toggle).not.toHaveBeenCalled();
  await expect(source.tail("local-shell")).resolves.toEqual([]);
  const listener = vi.fn();
  const off = shell.subscribe(listener);
  const activity = vi.fn();
  const offActivity = source.subscribeActivity(activity);
  const dispose = shell.mount(document.createElement("div"), vi.fn());
  mock.update?.(view);
  expect(source.getSnapshot()[0]?.reason).toBe("bash · process: shell");
  expect(shell.getSnapshot()).toEqual(view);
  expect(listener).toHaveBeenCalledOnce();
  mock.activity?.([
    { id: "foreign", rate: 5 },
    { id: "real-id", rate: 2000 },
  ]);
  expect(activity).toHaveBeenCalledExactlyOnceWith([{ id: "local-shell", rate: 2000 }]);
  vi.advanceTimersByTime(1000);
  expect(activity).toHaveBeenCalledTimes(101);
  await expect(source.tail("local-shell")).resolves.toEqual(["real output"]);
  await expect(source.tail("review")).resolves.toContain("Run npm test? (y/n)");
  await shell.toggle();
  await shell.open();
  await shell.restart();
  await shell.hide();
  expect(mock.toggle).toHaveBeenCalledTimes(2);
  expect(mock.restart).toHaveBeenCalledOnce();
  expect(mock.hide).toHaveBeenCalledOnce();
  mock.update?.({ ...view, state: "done", status: "Shell exited (0)" });
  expect(source.getSnapshot()[0]).toMatchObject({ state: "done", seen: false });
  mock.update?.({ ...view, state: "failed", status: "Shell exited (1)", visible: true });
  expect(source.getSnapshot()[0]).toMatchObject({ state: "failed", seen: true });
  off();
  offActivity();
  dispose();
  expect(mock.dispose).toHaveBeenCalledOnce();
  expect(mock.off).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
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
  expect(mock.toggle).toHaveBeenCalledTimes(4);
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
  for (let step = 0; step < 3; step++) {
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
