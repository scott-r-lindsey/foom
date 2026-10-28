import { agent, mock, settle, verdict } from "./app-board-fixture";
// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { createAppSource } from "../../../../src/renderer/board/live-board-source";
import type { WorkspaceSnapshot } from "../../../../src/shared/workspace";
test("source connects independently of views, reconciles events, preserves ordering, and keeps activity outside snapshots", async () => {
  const source = createAppSource();
  expect(source.previews?.getSnapshot()).toEqual([]);
  await expect(source.previews?.close("unknown")).resolves.toBeUndefined();
  await expect(source.previews?.pick("unknown")).resolves.toBeNull();
  await source.previews?.bounds("unknown", { x: 0, y: 0, width: 0, height: 0, visible: false });
  await expect(source.previews?.network?.("unknown", true)).rejects.toThrow(
    "Preview host unavailable",
  );
  await expect(source.previews?.popout?.("unknown")).rejects.toThrow("Preview host unavailable");
  await expect(source.previews?.reload?.("unknown")).rejects.toThrow("Preview host unavailable");
  const popout = vi.fn(() => Promise.resolve());
  const reload = vi.fn(() => Promise.resolve());
  const network = vi.fn(() => Promise.resolve());
  window.desktop.previews = {
    reload,
    network,
    popout,
    pick: vi.fn(),
    close: vi.fn(),
    bounds: vi.fn(),
    painted: vi.fn(async () => {}),
    cover: vi.fn(),
    onSnapshots: vi.fn(),
  };
  await source.previews?.reload?.("id");
  expect(reload).toHaveBeenCalledWith("id");
  await source.previews?.network?.("id", true);
  expect(network).toHaveBeenCalledWith("id", true);
  await source.previews?.popout?.("id");
  expect(popout).toHaveBeenCalledWith("id");
  delete window.desktop.previews;
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
  expect(mock.off).toHaveBeenCalledTimes(6);
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
  expect(source.getSnapshot()[0]?.reason).toBe("Unable to start shell.");
  const kills = mock.kill.mock.calls.length;
  await source.shell?.restart();
  expect(source.getSnapshot()[0]?.id).toBe("real-id");
  expect(mock.kill).toHaveBeenCalledTimes(kills);
});
test("launch, close and worktree actions refresh their inventories", async () => {
  const source = createAppSource();
  const off = source.worktrees?.subscribe?.(vi.fn());
  off?.();
  await source.config?.decide?.("keep", "held");
  expect(mock.configStatus).toHaveBeenCalledWith("keep", "held");
  expect(await source.worktrees?.load()).toMatchObject({ hooks: true });
  expect(await source.worktrees?.addRepository()).toBeNull();
  await expect(source.worktrees?.branches("/r")).resolves.toMatchObject({ head: "main" });
  expect(mock.branches).toHaveBeenCalledWith("/r");
  const inventories = mock.sidebarInventory.mock.calls.length;
  await expect(source.worktrees?.create("/r", "feature")).resolves.toEqual({
    path: "/r/feature",
    outcome: "new",
  });
  // Main picks the location; the sidebar lists the worktree before the field hears back.
  expect(mock.createWorktree).toHaveBeenCalledWith("/r", "feature");
  expect(mock.sidebarInventory.mock.calls.length).toBe(inventories + 1);
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
test("fresh foreground names replace cached row metadata and clear at the prompt", async () => {
  const source = createAppSource();
  const disconnect = source.connect?.();
  await settle();
  for (const name of ["sleep", "vim", ""]) {
    mock.workspace.mockResolvedValue({
      repositories: [],
      terminals: [{ ...agent("shell"), kind: "shell", agent: "shell", foregroundProgram: name }],
    });
    mock.changed?.();
    await settle();
    expect(source.getSnapshot().find((row) => row.id === "shell")?.foregroundProgram).toBe(name);
  }
  disconnect?.();
});

test("activity subscribers receive the final cached zero when views remount", async () => {
  const source = createAppSource();
  const disconnect = source.connect?.();
  await settle();
  mock.activity?.([{ id: "a", rate: 4000 }]);
  mock.activity?.([{ id: "a", rate: 0 }]);
  const listener = vi.fn();
  const off = source.subscribeActivity(listener);
  expect(listener).toHaveBeenCalledWith([{ id: "a", rate: 0 }]);
  off();
  disconnect?.();
});

test("home-shell source refreshes rows and preserves its request-specific result", async () => {
  const source = createAppSource();
  mock.sidebarCommand.mockResolvedValueOnce({ terminalId: "home-created" });
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [{ ...agent("home-created"), kind: "shell", home: true }],
  });
  await expect(source.sidebarCommand?.({ kind: "home-shell" })).resolves.toEqual({
    terminalId: "home-created",
  });
  expect(source.getSnapshot().some((row) => row.id === "home-created")).toBe(true);
});
