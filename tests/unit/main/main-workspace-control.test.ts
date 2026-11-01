import { mock, start, invokeWindow, newWindow } from "./main-fixture";
import { expect, test, vi } from "vitest";

test("routes terminal events, hook signals and state through the workspace", async () => {
  await start();
  const events = mock.terminalEvents as {
    onQuiet(id: string): void;
    onExit(id: string, code: number): void;
    onInput(id: string): void;
    onRemoved(id: string): void;
  };
  events.onQuiet("a");
  events.onExit("a", 1);
  events.onInput("a");
  events.onRemoved("a");
  expect(mock.workspace.quiet).toHaveBeenCalledWith("a");
  expect(mock.workspace.exited).toHaveBeenCalledWith("a", 1);
  expect(mock.workspace.input).toHaveBeenCalledWith("a");
  expect(mock.workspace.removed).toHaveBeenCalledWith("a");

  expect(mock.shellEnvironment?.()).toEqual({});
  mock.environmentChanged?.();
  const deps = mock.workspace.deps as {
    environment(target: string): unknown;
    receiver(): Promise<unknown>;
    onExecution(event: unknown): void;
    onState(state: unknown): void;
    onChange(): void;
    acknowledgeAgyPluginOffer(): Promise<void>;
  };
  expect(deps.environment("claude")).toEqual([[], []]);
  await deps.acknowledgeAgyPluginOffer();
  deps.onChange();
  expect(mock.ipc.sendChanged).toHaveBeenCalledOnce();
  deps.onExecution({ terminalId: "a" });
  expect(mock.ipc.sendExecution).toHaveBeenCalledWith({ terminalId: "a" });
  deps.onState({ id: "a" });
  expect(mock.ipc.sendState).toHaveBeenCalledWith({ id: "a" });
  mock.listen.mockResolvedValue("receiver");
  await expect(deps.receiver()).resolves.toBe("receiver");
  const onSignal = mock.listen.mock.calls[0]?.[0] as (signal: unknown) => void;
  onSignal({ terminalId: "key" });
  expect(mock.workspace.hook).toHaveBeenCalledWith({ terminalId: "key" });

  const owns = mock.attachWorkspace.mock.calls[0]?.[2] as (id: string) => boolean;
  mock.terminals.owns.mockReturnValue(true);
  expect(owns("a")).toBe(true);
  mock.readyEvents.get("closed")?.();
  expect(mock.ipc.dispose).toHaveBeenCalledOnce();
  expect(mock.workspace.dispose).not.toHaveBeenCalled();
  expect(mock.setupIpc.dispose).toHaveBeenCalledOnce();
});

test("workspace content is routed to the trusted dialog service", async () => {
  await start();
  const request = mock.attachWorkspace.mock.calls[0]?.[3];
  if (typeof request !== "function") throw Error("Missing trusted dialog callback");
  await request({ title: "Remove?", accept: "Remove" });
  expect(mock.message).toHaveBeenCalledWith({ title: "Remove?", accept: "Remove" });
});

test("bypass defaults use a main-owned, cancel-first disclosure", async () => {
  await start();
  mock.message.mockResolvedValueOnce({ response: 0 });
  expect(await mock.setup.deps?.confirmBypass?.("claude", ["--dangerously-skip-permissions"])).toBe(
    false,
  );
  expect(mock.message).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: "Save bypass defaults for Claude Code?",
      detail:
        "A worktree is not a sandbox. With these arguments, the agent can act as you anywhere on the machine.",
      accept: "Save bypass defaults",
    }),
  );
  mock.message.mockResolvedValueOnce({ response: 1 });
  expect(await mock.setup.deps?.confirmBypass?.("codex", ["--yolo"])).toBe(true);
});

test("control startup publishes private discovery and binds trusted pairing callbacks", async () => {
  const { ControlRuntime } = await import("../../../src/main/control/runtime");
  const error = new Error("Private profile unavailable");
  const startControl = vi.spyOn(ControlRuntime, "start").mockRejectedValueOnce(error);
  mock.openWorktrees.mockResolvedValue({
    worktreeRoot: "/trees",
    listRepositories: () => [],
  });
  try {
    await start();
    expect(startControl).not.toHaveBeenCalled();
    const control = mock.workspace.deps?.control;
    if (!control) throw new Error("Expected control startup capability");
    await expect(control()).rejects.toBe(error);
    expect(startControl).toHaveBeenCalledExactlyOnceWith(
      "/test/user-data",
      expect.any(Function),
      expect.any(Object),
      // The mocked workspace has no orchestration; production passes Workspace.orchestration.
      undefined,
      expect.any(Function),
      expect.any(Function),
      expect.any(Object),
      expect.any(Function),
    );
    startControl.mock.calls[0]?.[5]?.();
    expect(mock.workspace.refresh).toHaveBeenCalled();
    expect(startControl.mock.calls[0]?.[1]?.()).toMatchObject([{ id: "t1" }, { id: "t2" }]);
    expect(mock.workspace.initializeControl).toHaveBeenCalled();
    startControl.mock.calls[0]?.[4]?.("t1", "connected");
    expect(mock.workspace.mcpConnectionChanged).toHaveBeenCalledWith("t1", "connected");
    const pairing = startControl.mock.calls[0]?.[2];
    expect(pairing?.repository("/foreign")).toBeUndefined();
    const { worktrees } = await import("../../../src/main/wiring/application");
    vi.spyOn(worktrees, "listRepositories").mockReturnValue([{ path: "/repo", name: "Repo" }]);
    expect(pairing?.repository("/repo")).toBe("/repo");
    expect(startControl.mock.calls[0]?.[7]?.()).toMatchObject([{ name: "repo" }]);
    await pairing?.approve("/repo", "ABCD1234", new AbortController().signal, Date.now() + 60000);
    expect(mock.message).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Pair this CLI with Foom?",
      }),
    );
    await newWindow();
    const second = mock.instances[1];
    if (!second) throw new Error("Missing second board");
    mock.window.isFocused.mockReturnValue(false);
    second.isFocused = vi.fn(() => true);
    await pairing?.approve("/repo", "NEXT1234", new AbortController().signal, Date.now() + 60000);
    expect(mock.confirmParent).toHaveBeenLastCalledWith(second);
    mock.readyEvents.get("closed")?.();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      pairing?.approve("/repo", "STOP1234", cancelled.signal, Date.now() + 60000),
    ).resolves.toBe(false);
    expect(mock.instances).toHaveLength(2);
    await pairing?.approve("/repo", "OPEN1234", new AbortController().signal, Date.now() + 60000);
    expect(mock.instances).toHaveLength(3);
    expect(mock.confirmParent).toHaveBeenLastCalledWith(mock.instances[2]);
    mock.readyEvents.get("closed")?.();
    const opening = new AbortController();
    mock.window.loadURL.mockImplementationOnce(() => {
      opening.abort();
      return Promise.resolve();
    });
    await expect(
      pairing?.approve("/repo", "LATE1234", opening.signal, Date.now() + 60000),
    ).resolves.toBe(false);
    expect(mock.confirmParent).toHaveBeenCalledTimes(3);
  } finally {
    startControl.mockRestore();
  }
});

test("routes output, evidence and shell state into app-owned workspace", async () => {
  await start();
  const events = mock.terminalEvents as {
    onOutput(id: string): void;
    onEvidence(id: string, evidence: unknown): void;
    onForeground(id: string, name: string): void;
    onShellState(id: string, state: unknown): void;
  };
  events.onOutput("t1");
  events.onEvidence("t1", { text: "untrusted" });
  events.onForeground("t1", "vim");
  expect(mock.workspace.foreground).toHaveBeenCalledWith("t1", "vim");
  events.onShellState("t1", "ready");
  expect(mock.workspace.output).toHaveBeenCalledWith("t1");
  expect(mock.workspace.evidence).toHaveBeenCalledWith("t1", { text: "untrusted" });
  expect(mock.workspace.shellState).toHaveBeenCalledWith("t1", "ready");
});

test("pending removal reviews stay on the original board across focus changes", async () => {
  await start();
  await newWindow();
  const firstBoard = mock.instances[0];
  const second = mock.instances[1];
  if (!firstBoard || !second) throw Error("Missing second board");
  mock.window.isFocused.mockReturnValue(false);
  second.isFocused = vi.fn(() => true);
  const request = mock.workspace.deps?.dialog;
  if (!request) throw Error("Missing trusted dialog");
  const content = (id: string, group = "actor") => ({
    title: "Remove?",
    accept: "Approve all",
    removal: { group, item: { id, branch: id, path: `/trees/${id}`, changes: "" } },
  });
  let resolve: (value: { response: number }) => void = () => undefined;
  mock.message.mockImplementationOnce(
    () =>
      new Promise((answer) => {
        resolve = answer;
      }),
  );
  const first = request(content("one"), new AbortController().signal);
  expect(mock.confirmParent).toHaveBeenLastCalledWith(second);
  second.isFocused = vi.fn(() => false);
  mock.window.isFocused.mockReturnValue(true);
  mock.message.mockResolvedValueOnce({ response: 1 });
  await request(content("two"), new AbortController().signal);
  expect(mock.confirmParent).toHaveBeenLastCalledWith(second);
  await request(content("foreign", "other"), new AbortController().signal);
  expect(mock.confirmParent).toHaveBeenLastCalledWith(firstBoard);
  resolve({ response: 1 });
  await first;
  // Once all requests settle, the next batch follows the currently focused board.
  await request(content("fresh"), new AbortController().signal);
  expect(mock.confirmParent).toHaveBeenLastCalledWith(firstBoard);
});

test("child placement targets the parent's board or current board without focusing it", async () => {
  await start();
  await newWindow();
  await invokeWindow(1, "windows:sync", ["t1"]);
  const place = mock.workspace.deps?.placeChild;
  if (!place) throw new Error("Missing placement callback");
  mock.window.focus.mockClear();
  mock.window.show.mockClear();
  place("child", "t1");
  expect(mock.window.webContents.send).toHaveBeenCalledWith("app-menu:session", "child", true);
  place("hidden-child", "hidden-parent");
  expect(mock.window.webContents.send).toHaveBeenCalledWith(
    "app-menu:session",
    "hidden-child",
    true,
  );
  mock.window.isFocused.mockReturnValue(false);
  place("fallback-child", "hidden-parent");
  expect(mock.window.webContents.send).toHaveBeenCalledWith(
    "app-menu:session",
    "fallback-child",
    true,
  );
  expect(mock.window.focus).not.toHaveBeenCalled();
  expect(mock.window.show).not.toHaveBeenCalled();
});
