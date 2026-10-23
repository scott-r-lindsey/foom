import { agent, mock, settle, verdict } from "./app-board-fixture";
// @vitest-environment jsdom
import { expect, test, vi } from "vitest";
import { createAppSource } from "../../../../src/renderer/board/live-board-source";
import type { ExecutionTransition } from "../../../../src/shared/execution";
import type { TerminalState } from "../../../../src/shared/workspace";
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

test("restored sessions have no host view or tail and resuming clears previous exit evidence", async () => {
  const source = createAppSource();
  const disconnect = source.connect?.();
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [{ ...agent("a"), exited: true, dormant: true, conversationId: "saved" }],
  });
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()[0]).toMatchObject({
    exited: true,
    dormant: true,
    conversationId: "saved",
  });
  expect(mock.tail).not.toHaveBeenCalled();
  await source.createView?.().open("a");
  expect(mock.open).not.toHaveBeenCalled();
  mock.exit?.("a", 1);
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [{ ...agent("a"), exited: false, conversationId: "saved" }],
  });
  await source.sidebarCommand?.({ kind: "resume", id: "a" });
  expect(source.getSnapshot()[0]).toMatchObject({
    exited: false,
    dormant: false,
    state: "working",
    conversationId: "saved",
  });
  await source.createView?.().open("a");
  expect(mock.open).toHaveBeenCalledWith("a");
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [{ ...agent("a"), exited: false }],
  });
  await source.sidebarCommand?.({ kind: "new-conversation", id: "a" });
  expect(source.getSnapshot()[0]?.conversationId).toBeUndefined();
  disconnect?.();
});

test("an in-flight live snapshot cannot erase a newer process exit or roll back a relaunch", async () => {
  const source = createAppSource();
  const initial = { ...agent("a"), exited: false, launchVersion: 1 };
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [initial] });
  const off = source.connect?.();
  await settle();
  mock.exit?.("a", 4);
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()[0]).toMatchObject({ exited: true, state: "failed" });
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [{ ...initial, launchVersion: 2 }],
  });
  await source.sidebarCommand?.({ kind: "resume", id: "a" });
  expect(source.getSnapshot()[0]).toMatchObject({ exited: false, launchVersion: 2 });
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [{ ...initial, exited: true }] });
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()[0]).toMatchObject({ exited: false, launchVersion: 2 });
  off?.();
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
  const cleanupProgress = {
    total: 1,
    done: 0,
    phase: "remove" as const,
    stopped: false,
    items: [],
  };
  const inventory = vi.spyOn(window.desktop, "sidebarInventory").mockResolvedValue({
    repositories: [{ ...repository, worktrees: [tree], cleanup: cleanupProgress }],
    shell: "bash",
  });
  mock.workspace.mockResolvedValue({ repositories: [repository], terminals: [entry] });
  const source = createAppSource();
  const disconnect = source.connect?.();
  await settle();
  expect(source.getSnapshot()[0]?.worktreeRemoved).toBe(false);
  expect(source.getSidebar?.()[0]?.cleanup).toEqual(cleanupProgress);
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

test.each(["snapshot", "state", "exit"] as const)(
  "resume drops old snapshot verdicts while preserving new %s evidence",
  async (evidence) => {
    const old = { ...agent("a", { ...verdict("a"), state: "done" as const }), exited: true };
    mock.workspace.mockResolvedValue({ repositories: [], terminals: [old] });
    const source = createAppSource();
    const off = source.connect?.();
    await settle();
    const pending = Promise.withResolvers<undefined>();
    mock.sidebarCommand.mockReturnValueOnce(pending.promise);
    const resuming = source.sidebarCommand?.({ kind: "resume", id: "a" });
    await settle();
    mock.changed?.();
    await settle();
    if (evidence === "state") mock.state?.(verdict("a", 200));
    if (evidence === "exit") mock.exit?.("a", 3);
    mock.workspace.mockResolvedValue({
      repositories: [],
      terminals: [{ ...agent("a"), launchVersion: 1, exited: false }],
    });
    pending.resolve(undefined);
    await resuming;
    expect(source.getSnapshot()[0]).toMatchObject({
      launchVersion: 1,
      state: evidence === "state" ? "needs_input" : evidence === "exit" ? "failed" : "quiet_ok",
      exited: evidence === "exit",
    });
    off?.();
  },
);

test.each(["state", "exit"] as const)(
  "host replacement drops late old events but retains new %s",
  async (event) => {
    const old = { ...agent("a"), exited: true, launchVersion: 1 };
    mock.workspace.mockResolvedValue({ repositories: [], terminals: [old] });
    const source = createAppSource();
    const off = source.connect?.();
    await settle();
    const pending = Promise.withResolvers<undefined>();
    mock.sidebarCommand.mockReturnValueOnce(pending.promise);
    const resuming = source.sidebarCommand?.({ kind: "resume", id: "a" });
    await settle();
    mock.state?.({ ...verdict("a", 200), state: "done" });
    mock.exit?.("a", 0);
    mock.availability?.("a", false);
    mock.availability?.("a", true); // Failed-shutdown restore is not a new launch.
    expect(source.getSnapshot()[0]?.launchVersion).toBe(1);
    mock.availability?.("a", true, true);
    expect(source.getSnapshot()[0]).toMatchObject({
      state: "working",
      exited: false,
      launchVersion: 2,
    });
    if (event === "state") mock.state?.(verdict("a", 300));
    else mock.exit?.("a", 2);
    mock.changed?.(); // An old in-flight snapshot arrives after the new event.
    await settle();
    mock.workspace.mockResolvedValue({
      repositories: [],
      terminals: [{ ...agent("a"), launchVersion: 2, exited: false }],
    });
    pending.resolve(undefined);
    await resuming;
    expect(source.getSnapshot()[0]).toMatchObject({
      state: event === "state" ? "needs_input" : "failed",
      launchVersion: 2,
    });
    off?.();
  },
);

test("a failed replacement after host reset restores the saved dormant record", async () => {
  const saved = {
    ...agent("a"),
    exited: true,
    dormant: true,
    launchVersion: 1,
    conversationId: "saved",
  };
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [saved] });
  const source = createAppSource();
  const off = source.connect?.();
  await settle();
  mock.sidebarCommand.mockImplementationOnce(() => {
    mock.availability?.("a", true, true);
    mock.state?.(verdict("a", 300));
    return Promise.reject(new Error("launch failed"));
  });
  await expect(source.sidebarCommand?.({ kind: "resume", id: "a" })).rejects.toThrow(
    "launch failed",
  );
  expect(source.getSnapshot()[0]).toMatchObject({
    exited: true,
    dormant: true,
    launchVersion: 1,
    state: "quiet_ok",
    conversationId: "saved",
  });
  off?.();
});

test("execution overlays verdicts, rejects stale events, and waits for each turn's result", async () => {
  const initial = { terminalId: "a", launch: 1, revision: 0, turn: 0, phase: "starting" as const };
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [{ ...agent("a"), execution: initial }, agent("b")],
  });
  const source = createAppSource();
  const off = source.connect?.();
  await settle();
  const current = () => source.getSnapshot().find((row) => row.id === "a");
  expect(current()?.state).toBe("quiet_ok");
  const working: ExecutionTransition = {
    ...initial,
    revision: 1,
    turn: 1,
    phase: "working",
    from: "starting",
    to: "working",
    source: "title",
    at: 10,
  };
  mock.execution?.(working);
  expect(current()?.state).toBe("working");
  mock.state?.({ ...verdict("a"), execution: working, state: "working" });
  const idle: ExecutionTransition = {
    ...working,
    revision: 2,
    phase: "idle",
    from: "working",
    to: "idle",
    at: 20,
  };
  mock.execution?.(idle);
  expect(current()?.state).toBe("quiet_ok");
  mock.state?.({ ...verdict("a", 200), execution: working, state: "done" });
  expect(current()?.state).toBe("quiet_ok");
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [
      {
        ...agent("a", { ...verdict("a", 9000), execution: working, state: "done" }),
        execution: working,
      },
    ],
  });
  mock.changed?.();
  await settle();
  mock.state?.({ ...verdict("a", 201), execution: idle, state: "done" });
  expect(current()?.state).toBe("done");
  mock.execution?.(working);
  expect(current()?.execution?.revision).toBe(2);
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [
      { ...agent("a", { ...verdict("a", 300), execution: idle, state: "done" }), execution: idle },
      agent("b"),
    ],
  });
  mock.changed?.();
  await settle();
  expect(current()?.state).toBe("done");
  const blocked: ExecutionTransition = {
    ...idle,
    revision: 3,
    phase: "blocked",
    from: "idle",
    to: "blocked",
    source: "screen",
  };
  mock.execution?.(blocked);
  expect(current()?.state).toBe("needs_input");
  const resumed: ExecutionTransition = { ...working, launch: 2 };
  mock.execution?.(resumed);
  mock.state?.({ ...verdict("a", 500), execution: blocked });
  expect(current()?.state).toBe("working");
  mock.execution?.({
    ...resumed,
    revision: 2,
    from: "working",
    to: "exited",
    phase: "exited",
    source: "exit",
  });
  mock.exit?.("a", 1);
  expect(current()?.state).toBe("failed");
  off?.();
});

test("terminal views read current exit state when opening an existing session", async () => {
  mock.workspace.mockResolvedValue({ repositories: [], terminals: [agent("a")] });
  const source = createAppSource();
  const disconnect = source.connect?.();
  await settle();
  source.createView?.();
  expect(mock.viewAvailable?.("a")).toBe(true);
  expect(mock.viewAvailable?.("unknown")).toBe(false);
  expect(mock.viewExited?.("a")).toBe(false);
  mock.exit?.("a", 0);
  expect(mock.viewExited?.("a")).toBe(true);
  expect(mock.viewExited?.("unknown")).toBe(false);
  disconnect?.();
});

test("main waiting presentation clears on equal-timestamp snapshots and real attention", async () => {
  const execution: ExecutionTransition = {
    terminalId: "a",
    launch: 1,
    revision: 2,
    turn: 1,
    phase: "idle",
    from: "working",
    to: "idle",
    source: "hook",
    at: 10,
  };
  const state: TerminalState = { ...verdict("a", 100), execution, state: "done" };
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [{ ...agent("a", state), execution }],
  });
  const source = createAppSource();
  const off = source.connect?.();
  await settle();
  mock.state?.({ ...state, waitingOn: 2 });
  // Snapshot is authoritative at the same timestamp; a later refresh carries the derived count.
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [{ ...agent("a", { ...state, waitingOn: 2 }), execution }],
  });
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()[0]).toMatchObject({
    state: "waiting",
    reason: "Waiting on 2",
    waitingSince: 0,
  });
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [{ ...agent("a", state), execution }],
  });
  mock.changed?.();
  await settle();
  expect(source.getSnapshot()[0]?.state).toBe("done");
  mock.state?.({ ...state, verdictId: "failed", state: "failed" });
  expect(source.getSnapshot()[0]?.state).toBe("failed");
  const blocked = { ...execution, revision: 3, phase: "blocked" as const };
  mock.state?.({
    ...state,
    timestamp: 101,
    execution: blocked,
    state: "needs_input",
    attentionKind: "question",
  });
  expect(source.getSnapshot()[0]?.state).toBe("needs_input");
  off?.();
});

test.each(["orchestration:unread", "probe:waiting"])(
  "%s attention overrides working until main clears the reminder",
  async (signal) => {
    const execution: ExecutionTransition = {
      terminalId: "a",
      launch: 1,
      revision: 2,
      turn: 1,
      phase: "working",
      from: "idle",
      to: "working",
      source: "hook",
      at: 10,
    };
    const state: TerminalState = { ...verdict("a", 100), execution, state: "working" };
    mock.workspace.mockResolvedValue({
      repositories: [],
      terminals: [{ ...agent("a", state), execution }],
    });
    const source = createAppSource();
    const off = source.connect?.();
    await settle();
    mock.state?.(state);
    mock.workspace.mockResolvedValue({
      repositories: [],
      terminals: [
        {
          ...agent("a", {
            ...state,
            timestamp: 10,
            state: "needs_input",
            verdictId: null,
            signal,
            reason: signal === "probe:waiting" ? "Probe waiting" : "Child report unread",
          }),
          execution,
        },
      ],
    });
    mock.changed?.();
    await settle();
    expect(source.getSnapshot()[0]).toMatchObject({
      state: "needs_input",
      reason:
        signal === "probe:waiting" ? "Probe waiting" : "Child report unread · orchestration:unread",
    });
    mock.workspace.mockResolvedValue({
      repositories: [],
      terminals: [{ ...agent("a", state), execution }],
    });
    mock.changed?.();
    await settle();
    expect(source.getSnapshot()[0]?.state).toBe("working");
    off?.();
  },
);

test("queued restores project Starting without the saved host's failure verdict", async () => {
  const source = createAppSource();
  mock.workspace.mockResolvedValue({
    repositories: [],
    terminals: [
      {
        ...agent("queued", { ...verdict("queued", 10), state: "failed" }),
        dormant: true,
        exited: false,
      },
    ],
  });
  const disconnect = source.connect?.();
  await settle();
  expect(source.getSnapshot()[0]).toMatchObject({
    id: "queued",
    dormant: true,
    exited: false,
    state: "quiet_ok",
    reason: "Starting",
  });
  await source.createView?.().open("queued");
  expect(mock.open).not.toHaveBeenCalled();
  disconnect?.();
});
