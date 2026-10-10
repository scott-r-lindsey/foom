import { beforeEach, expect, test, vi } from "vitest";
import type { DesktopApi } from "../../../src/shared/desktop";
const mock = vi.hoisted(() => ({
  expose: vi.fn<(name: string, api: DesktopApi) => void>(),
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  send: vi.fn(),
  on: vi.fn<(channel: string, callback: (event: unknown, ...values: unknown[]) => void) => void>(),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mock.expose },
  ipcRenderer: mock,
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
async function bridge() {
  await import("../../../src/preload/preload");
  const api = mock.expose.mock.calls[0]?.[1];
  if (!api) throw new Error("Missing bridge");
  mock.on.mockClear();
  return api;
}
test("starts through the dedicated channel and validates the response", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue({ id: "one", title: "bash" });
  await expect(api.create(80, 24)).resolves.toEqual({ id: "one", title: "bash" });
  expect(mock.invoke).toHaveBeenCalledWith("terminal:create", 80, 24);
  mock.invoke.mockResolvedValue({});
  await expect(api.create(80, 24)).rejects.toThrow("Invalid terminal response");
  mock.invoke.mockRejectedValue(new Error("spawn failed"));
  await expect(api.create(80, 24)).rejects.toThrow("spawn failed");
});
test("chunks large pastes and forwards resize and flow control", async () => {
  const api = await bridge();
  api.input("one", "x".repeat(65537));
  expect(mock.send.mock.calls).toEqual([
    ["terminal:input", "one", "x".repeat(65536)],
    ["terminal:input", "one", "x"],
  ]);
  api.resize("one", 100, 30);
  api.acknowledge("one", "view", 99);
  expect(mock.send).toHaveBeenCalledWith("terminal:resize", "one", 100, 30);
  expect(mock.send).toHaveBeenCalledWith("terminal:ack", "one", "view", 99);
});
test("strips event objects, validates events, and removes listeners", async () => {
  const api = await bridge();
  const data = vi.fn();
  const exit = vi.fn();
  const offData = api.onData(data);
  const offExit = api.onExit(exit);
  const dataHandler = mock.on.mock.calls[0]?.[1];
  const exitHandler = mock.on.mock.calls[1]?.[1];
  dataHandler?.({}, "one", "view", "hello");
  dataHandler?.({}, null);
  exitHandler?.({}, "one", 0);
  exitHandler?.({}, "bad");
  expect(data.mock.calls).toEqual([["one", "view", "hello"]]);
  expect(exit.mock.calls).toEqual([["one", 0]]);
  offData();
  offExit();
  expect(mock.removeListener).toHaveBeenCalledWith("terminal:data", dataHandler);
  expect(mock.removeListener).toHaveBeenCalledWith("terminal:exit", exitHandler);
});

test("lifecycle requests and code-point-safe paste chunks", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue(undefined);
  await api.attach("one");
  await api.detach("one");
  await api.kill("one");
  expect(mock.invoke.mock.calls).toEqual([
    ["terminal:attach", "one"],
    ["terminal:detach", "one"],
    ["terminal:kill", "one"],
  ]);
  api.input("one", "x".repeat(65535) + "😀z");
  expect(mock.send.mock.calls).toEqual([
    ["terminal:input", "one", "x".repeat(65535)],
    ["terminal:input", "one", "😀z"],
  ]);
});

test.each([
  ["emoji across the boundary", "x".repeat(65535) + "😀tail", ["x".repeat(65535), "😀tail"]],
  [
    "emoji ending at the boundary",
    "x".repeat(65534) + "😀tail",
    ["x".repeat(65534) + "😀", "tail"],
  ],
  ["emoji after the boundary", "x".repeat(65536) + "😀", ["x".repeat(65536), "😀"]],
  [
    "successive boundaries",
    "x".repeat(65535) + "😀" + "y".repeat(65533) + "😀",
    ["x".repeat(65535), "😀" + "y".repeat(65533), "😀"],
  ],
  ["lone high surrogate", "x".repeat(65535) + "\ud800z", ["x".repeat(65535) + "\ud800", "z"]],
  [
    "high surrogate followed by BMP text",
    "x".repeat(65535) + "\ud800\ue000",
    ["x".repeat(65535) + "\ud800", "\ue000"],
  ],
  ["empty input", "", []],
])("preserves input with %s", async (_label, input, chunks) => {
  const api = await bridge();
  api.input("one", input);
  expect(mock.send.mock.calls).toEqual(chunks.map((chunk) => ["terminal:input", "one", chunk]));
  expect(chunks.join("")).toBe(input);
  expect(chunks.every((chunk) => chunk.length <= 65536)).toBe(true);
});

test("validates tail replies and activity batches and removes subscriptions", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue(["plain text"]);
  await expect(api.tail("one", 40)).resolves.toEqual(["plain text"]);
  expect(mock.invoke).toHaveBeenCalledWith("terminal:tail", "one", 40);
  for (const reply of [null, [3], Array.from({ length: 10001 }, () => "")]) {
    mock.invoke.mockResolvedValue(reply);
    await expect(api.tail("one", 40)).rejects.toThrow("Invalid terminal tail");
  }
  const callback = vi.fn();
  const off = api.onActivity(callback);
  const listener = mock.on.mock.calls.find(([channel]) => channel === "terminal:activity")?.[1];
  if (!listener) throw new Error("Missing listener");
  for (const batch of [
    null,
    [null],
    [1],
    [{}],
    [{ id: 1 }],
    [{ id: "" }],
    [{ id: "one" }],
    [{ id: "one", rate: "1" }],
    [{ id: "one", rate: NaN }],
    [{ id: "one", rate: -1 }],
  ])
    listener({}, batch);
  expect(callback).not.toHaveBeenCalled();
  listener({}, [{ id: "one", rate: 3 }]);
  expect(callback).toHaveBeenCalledWith([{ id: "one", rate: 3 }]);
  off();
  expect(mock.removeListener).toHaveBeenCalledWith("terminal:activity", listener);
});

test("workspace requests use their own channels", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue("reply");
  await expect(api.workspace()).resolves.toBe("reply");
  await api.addRepository();
  await api.worktrees("/repos/app");
  await api.createWorktree("/repos/app", "feature", "root");
  await api.scanAgents(true);
  await api.changeAgyPlugin("install");
  const request = {
    agent: "claude" as const,
    repository: "/r",
    worktree: "/w",
    cols: 80,
    rows: 24,
  };
  await api.launchAgent(request);
  await expect(api.feedback("t1", "v1", "dismissed")).resolves.toBeUndefined();
  expect(mock.invoke.mock.calls).toEqual([
    ["workspace:snapshot"],
    ["workspace:add-repository"],
    ["workspace:worktrees", "/repos/app"],
    ["workspace:create-worktree", "/repos/app", "feature", "root"],
    ["agents:scan", true],
    ["agents:agy-plugin", "install"],
    ["agents:launch", request],
    ["terminal:feedback", "t1", "v1", "dismissed"],
  ]);
});
test("setup requests use their own channels and never read a key back", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue("reply");
  await expect(api.listThemes()).resolves.toBe("reply");
  await api.openThemesFolder("theme");
  await expect(api.setupState()).resolves.toBe("reply");
  await api.saveSetup({ hooks: false });
  expect(mock.invoke.mock.calls).toEqual([
    ["theme:list"],
    ["theme:open-folder", "theme"],
    ["setup:state"],
    ["setup:save", { hooks: false }],
  ]);
  expect(Object.keys(api).some((key) => /get.*key|read.*key/i.test(key))).toBe(false);
});
test("environment requests use their own channels and copy import names", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue("reply");
  const change = { scope: "all", previous: null, name: "A", value: "1", secret: false } as const;
  const names = ["HTTPS_PROXY"];
  await expect(api.environmentState()).resolves.toBe("reply");
  await api.saveEnvironment(change);
  await api.removeEnvironment("codex", "A");
  await api.readShellEnvironment();
  await api.importEnvironment(names);
  expect(mock.invoke.mock.calls).toEqual([
    ["environment:state"],
    ["environment:save", change],
    ["environment:remove", "codex", "A"],
    ["environment:read-shell"],
    ["environment:import", ["HTTPS_PROXY"]],
  ]);
  expect(mock.invoke.mock.calls.at(-1)?.[1]).not.toBe(names);
});
test("code scans report validated progress and use their own channels", async () => {
  const api = await bridge();
  const progress = vi.fn();
  mock.invoke.mockResolvedValueOnce("scan");
  const pending = api.scanCode("s1", "/code", progress);
  expect(mock.invoke).toHaveBeenLastCalledWith("setup:scan-code", "s1", "/code");
  const listener = mock.on.mock.calls.find(([name]) => name === "setup:scan-progress")?.[1];
  if (!listener) throw new Error("Missing listener");
  listener({}, "s1", { folders: 3, repositories: 1 });
  listener({}, "other", { folders: 3, repositories: 1 });
  listener({}, "s1", { folders: "3", repositories: 1 });
  listener({}, "s1", null);
  await expect(pending).resolves.toBe("scan");
  expect(progress).toHaveBeenCalledExactlyOnceWith({ folders: 3, repositories: 1 });
  expect(mock.removeListener).toHaveBeenCalledWith("setup:scan-progress", listener);
  mock.invoke.mockResolvedValue("reply");
  await api.codeSuggestions();
  await api.applyRepositories(["/code/a"]);
  expect(mock.invoke.mock.calls.slice(-2)).toEqual([
    ["setup:code-suggestions"],
    ["setup:apply-repositories", ["/code/a"]],
  ]);
});
test("setup changes from main are validated and can be unsubscribed", async () => {
  const api = await bridge();
  const callback = vi.fn();
  const off = api.onSetupChange(callback);
  const listener = mock.on.mock.calls.find(([name]) => name === "setup:changed")?.[1];
  if (!listener) throw new Error("Missing listener");
  const state = { settings: {}, worktreeRoot: "/w" };
  for (const value of [state, null, { ...state, settings: null }, { ...state, worktreeRoot: 1 }])
    listener({}, value);
  expect(callback).toHaveBeenCalledExactlyOnceWith(state);
  off();
  expect(mock.removeListener).toHaveBeenCalledWith("setup:changed", listener);
});
test("terminal state events are validated and can be unsubscribed", async () => {
  const api = await bridge();
  const callback = vi.fn();
  const off = api.onState(callback);
  const handler = mock.on.mock.calls.find(([channel]) => channel === "terminal:state")?.[1];
  const state = {
    id: "t1",
    verdictId: null,
    state: "needs_input",
    reason: "r",
    signal: "s",
    confidence: 1,
    timestamp: 5,
  };
  handler?.({}, state);
  handler?.({}, { ...state, verdictId: "v1" });
  for (const bad of [
    null,
    [],
    { ...state, id: 1 },
    { ...state, verdictId: 2 },
    { ...state, state: "exploded" },
    { ...state, reason: null },
    { ...state, signal: 0 },
    { ...state, confidence: "high" },
    { ...state, timestamp: "now" },
  ])
    handler?.({}, bad);
  expect(callback.mock.calls).toEqual([[state], [{ ...state, verdictId: "v1" }]]);
  off();
  expect(mock.removeListener).toHaveBeenCalledWith("terminal:state", handler);
});

test("workspace notifications invalidate snapshots and unsubscribe", async () => {
  const api = await bridge();
  const callback = vi.fn();
  const off = api.onWorkspaceChange(callback);
  const listener = mock.on.mock.calls.find(([channel]) => channel === "workspace:changed")?.[1];
  listener?.({});
  expect(callback).toHaveBeenCalledOnce();
  off();
  expect(mock.removeListener).toHaveBeenCalledWith("workspace:changed", listener);
});

test("worktree launch and removal have dedicated channels", async () => {
  const api = await bridge();
  const request = {
    repository: "/r",
    branch: "feature",
    run: "shell" as const,
    acknowledgeCodexNotifierReplacement: false,
  };
  await api.startWorktree(request);
  await api.removeWorktree("t1");
  await api.sidebarInventory();
  await api.sidebarCommand({ kind: "stop", id: "t1" });
  expect(mock.invoke).toHaveBeenCalledWith("workspace:start", request);
  expect(mock.invoke).toHaveBeenCalledWith("workspace:remove", "t1");
  expect(mock.invoke).toHaveBeenCalledWith("workspace:sidebar");
  expect(mock.invoke).toHaveBeenCalledWith("workspace:sidebar-command", { kind: "stop", id: "t1" });
});

test("board commands accept only known actions and unsubscribe", async () => {
  const api = await bridge();
  const callback = vi.fn<(command: string) => void>();
  const off = api.onBoardCommand(callback);
  const handler = mock.on.mock.calls[0]?.[1];
  handler?.({}, "sidebar");
  handler?.({}, "next-waiting");
  handler?.({}, "settings");
  handler?.({}, "foreign");
  handler?.({}, { command: "sidebar" });
  expect(callback.mock.calls).toEqual([["sidebar"], ["next-waiting"], ["settings"]]);
  off();
  expect(mock.removeListener).toHaveBeenCalledWith("board:command", handler);
});

test("preserves wheel origin through the bridge", async () => {
  const api = await bridge();
  api.input("one", "\x1b[B", "wheel");
  expect(mock.send).toHaveBeenCalledWith("terminal:input", "one", "\x1b[B", "wheel");
});

test("only known tile commands cross the navigation bridge", async () => {
  const api = await bridge();
  const callback = vi.fn<(command: string) => void>();
  const off = api.onBoardCommand(callback);
  const listener = mock.on.mock.calls.find(([channel]) => channel === "board:command")?.[1];
  const commands = [
    "tile-1",
    "tile-2",
    "tile-3",
    "tile-4",
    "tile-5",
    "tile-6",
    "tile-7",
    "tile-8",
    "tile-9",
    "maximize",
    "left",
    "right",
    "up",
    "down",
    "split-right",
    "split-down",
    "close-tile",
    "hide-session",
  ];
  for (const command of [...commands, "tile-0", "tile-10", {}, null]) listener?.({}, command);
  expect(callback.mock.calls.map(([command]) => command)).toEqual(commands);
  off();
});

test("removal notifications validate IDs and strip event objects", async () => {
  const api = await bridge();
  const removed = vi.fn();
  const off = api.onTerminalAvailability(removed);
  const handler = mock.on.mock.calls.find(([channel]) => channel === "terminal:availability")?.[1];
  for (const ids of [null, 42, [""], ["x".repeat(201)], ["owned", 42]]) handler?.({}, ids, false);
  handler?.({}, ["owned"], false);
  handler?.({}, ["owned"], "invalid");
  handler?.({}, ["owned"], true, true);
  expect(removed.mock.calls).toEqual([
    ["owned", false],
    ["owned", true, true],
  ]);
  off();
  expect(mock.removeListener).toHaveBeenCalledWith("terminal:availability", handler);
});

test("view flush acknowledgement runs after callbacks and validates its envelope", async () => {
  await import("../../../src/preload/preload");
  const handler = mock.on.mock.calls.find(([channel]) => channel === "terminal:flush-views")?.[1];
  for (const [ids, token] of [
    [null, 1],
    [[42], 1],
    [["one"], "bad"],
    [["one"], 0],
    [["one"], 1.2],
  ])
    handler?.({}, ids, token);
  handler?.({}, ["one"], 1);
  expect(mock.send).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(mock.send).toHaveBeenCalledExactlyOnceWith("terminal:views-flushed", ["one"], 1);
});

test("confirmation bridge copies only the arm, strips IPC events and never exposes dialog answers", async () => {
  const api = await bridge();
  const receive = vi.fn();
  const off = api.confirmations.subscribe(receive);
  const listener = mock.on.mock.calls[0]?.[1];
  for (const value of [
    undefined,
    {},
    { nonce: 1 },
    { nonce: "n", target: 1 },
    { nonce: "n", target: "t", label: 1 },
  ])
    listener?.({}, value);
  const arm = { nonce: "n", target: "t", label: "Stop" };
  listener?.({}, { ...arm, answer: true });
  listener?.({}, null);
  expect(receive.mock.calls).toEqual([[arm], [null, false]]);
  await api.confirmations.confirm(arm);
  await api.confirmations.cancel();
  expect(mock.invoke).toHaveBeenCalledWith("confirmation:confirm", "n", "t");
  expect(mock.invoke).toHaveBeenCalledWith("confirmation:cancel");
  expect(api.confirmations).not.toHaveProperty("answer");
  off();
  expect(mock.removeListener).toHaveBeenCalledWith("confirmation:armed", listener);
});

test("a trusted dialog opening dismisses the board menu without exposing its answer", async () => {
  const api = await bridge();
  const close = vi.fn();
  const off = api.confirmations.onDialog?.(close);
  const listener = mock.on.mock.calls[0]?.[1];
  listener?.({ sender: "ignored" });
  expect(close).toHaveBeenCalledOnce();
  off?.();
  expect(mock.removeListener).toHaveBeenCalledWith("confirmation:dialog", listener);
});
test.each([false, true])(
  "exposes only the development flag from main's preload arguments (%s)",
  async (development) => {
    vi.spyOn(process, "argv", "get").mockReturnValue(development ? ["--foom-development"] : []);
    expect((await bridge()).isDevelopment).toBe(development);
  },
);

test("sound capabilities send only typed requests and unsubscribe refresh events", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue(undefined);
  await api.sounds.list();
  const request = { kind: "done", source: "user", file: "bell.wav" } as const;
  await api.sounds.read(request);
  await api.sounds.openFolder();
  await api.sounds.notices();
  expect(mock.invoke.mock.calls).toEqual([
    ["sound:list"],
    ["sound:read", request],
    ["sound:open-folder"],
    ["sound:notices"],
  ]);
  const changed = vi.fn();
  const off = api.sounds.onChange(changed);
  const handler = mock.on.mock.calls.find(([channel]) => channel === "sound:changed")?.[1];
  handler?.({});
  expect(changed).toHaveBeenCalledWith();
  off();
  expect(mock.removeListener).toHaveBeenCalledWith("sound:changed", handler);
});

test("execution transitions validate metadata and unsubscribe without exposing IPC events", async () => {
  const api = await bridge();
  const callback = vi.fn();
  const off = api.onExecution(callback);
  const handler = mock.on.mock.calls[0]?.[1];
  const event = {
    terminalId: "agent",
    launch: 1,
    revision: 2,
    turn: 1,
    from: "working",
    to: "idle",
    phase: "idle",
    source: "hook",
    at: 10,
  };
  handler?.({}, event);
  for (const invalid of [
    null,
    {},
    { ...event, terminalId: "" },
    { ...event, terminalId: "x".repeat(201) },
    { ...event, launch: -1 },
    { ...event, revision: Infinity },
    { ...event, turn: 0.5 },
    { ...event, phase: "fake" },
    { ...event, from: "idle" },
    { ...event, to: "working" },
    { ...event, from: "fake" },
    { ...event, source: "output" },
    { ...event, at: NaN },
  ])
    handler?.({}, invalid);
  expect(callback).toHaveBeenCalledExactlyOnceWith(event);
  off();
  expect(mock.removeListener).toHaveBeenCalledWith("agent:execution", handler);
});

test("application menu bridge forwards IDs and strips events from validated session navigation", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue([]);
  await api.appMenu.commands();
  await api.appMenu.shortcuts();
  await api.appMenu.execute("settings");
  expect(mock.invoke).toHaveBeenCalledWith("app-menu:shortcuts");
  await api.appMenu.setView({ available: true, maximized: false, tiles: 1 });
  expect(mock.invoke).toHaveBeenCalledWith("app-menu:execute", "settings");
  const open = vi.fn();
  const session = vi.fn();
  const offOpen = api.appMenu.onOpen(open);
  const offSession = api.appMenu.onSession(session);
  const sheet = vi.fn();
  const offSheet = api.appMenu.onShortcuts(sheet);
  const showing = mock.on.mock.calls.find(([channel]) => channel === "app-menu:shortcuts")?.[1];
  showing?.({}, "ignored payload");
  expect(sheet.mock.calls).toEqual([[]]);
  offSheet();
  expect(mock.removeListener).toHaveBeenCalledWith("app-menu:shortcuts", showing);
  const opening = mock.on.mock.calls.find(([channel]) => channel === "app-menu:open")?.[1];
  const navigate = mock.on.mock.calls.find(([channel]) => channel === "app-menu:session")?.[1];
  opening?.({});
  for (const value of [null, 1, "", "x".repeat(257), "one"]) navigate?.({}, value);
  expect(open.mock.calls).toEqual([[]]);
  expect(session.mock.calls).toEqual([["one"]]);
  offOpen();
  offSession();
  expect(mock.removeListener).toHaveBeenCalledWith("app-menu:session", navigate);
});

test("preload accepts menu board commands and rejects unknown values", async () => {
  const api = await bridge();
  const callback = vi.fn();
  const off = api.onBoardCommand(callback);
  const listener = mock.on.mock.calls.find(([name]) => name === "board:command")?.[1];
  for (const command of [
    "new-worktree",
    "add-repository",
    "preset-one",
    "preset-columns",
    "preset-rows",
    "preset-grid",
    "preset-main2",
    "preset-main3",
  ])
    listener?.({}, command);
  listener?.({}, "reload");
  listener?.({}, {});
  expect(callback).toHaveBeenCalledTimes(8);
  off();
});

test("window capabilities forward IDs and validate view and audio notifications", async () => {
  const api = (await bridge()).windows;
  if (!api?.audio) throw new Error("Missing window capabilities");
  mock.invoke.mockResolvedValue([]);
  await api.sync(["a"]);
  await api.select("a");
  await api.popout("a");
  expect(mock.invoke.mock.calls.slice(0, 3)).toEqual([
    ["windows:sync", ["a"]],
    ["windows:select", "a"],
    ["windows:popout", "a"],
  ]);
  const valid = [{ id: "a", window: 2 }];
  mock.invoke.mockResolvedValue(valid);
  await expect(api.snapshot()).resolves.toEqual(valid);
  mock.invoke.mockResolvedValue({});
  await expect(api.snapshot()).resolves.toEqual([]);
  const changed = vi.fn(),
    removed = vi.fn(),
    audio = vi.fn(),
    refuse = vi.fn();
  const offs = [
    api.onChanged(changed),
    api.onRemoved(removed),
    api.audio.onChanged(audio),
    api.audio.onRefuse(refuse),
  ];
  const emit = (channel: string, value?: unknown) =>
    mock.on.mock.calls.find(([name]) => name === channel)?.[1]({}, value);
  emit("windows:changed", valid);
  for (const value of [
    null,
    {},
    Array.from({ length: 8193 }, () => valid[0]),
    [null],
    [{ id: 1, window: 2 }],
    [{ id: "a".repeat(201), window: 2 }],
    [{ id: "a", window: "2" }],
    [{ id: "a", window: 1.5 }],
  ])
    emit("windows:changed", value);
  emit("windows:removed", "a");
  for (const value of [null, "", "a".repeat(201)]) emit("windows:removed", value);
  expect(changed.mock.calls).toEqual([[valid]]);
  expect(removed.mock.calls).toEqual([["a"]]);
  for (const state of [
    { enabled: true, focusedId: "a" },
    { enabled: false, focusedId: null },
  ]) {
    emit("windows:audio", state);
    mock.invoke.mockResolvedValue(state);
    await expect(api.audio.state()).resolves.toEqual(state);
  }
  for (const invalid of [
    null,
    {},
    { enabled: "yes", focusedId: null },
    { enabled: true, focusedId: 2 },
    { enabled: true, focusedId: "x".repeat(201) },
  ])
    emit("windows:audio", invalid);
  expect(audio).toHaveBeenCalledTimes(2);
  mock.invoke.mockResolvedValue(null);
  await expect(api.audio.state()).resolves.toEqual({ enabled: false, focusedId: null });
  await api.audio.focus("a");
  await api.audio.refuse();
  emit("windows:refuse");
  expect(refuse).toHaveBeenCalledOnce();
  for (const off of offs) off();
  expect(mock.removeListener).toHaveBeenCalledTimes(4);
});
test("main-generated window arguments scope metadata without exposing paths", async () => {
  const original = process.argv;
  process.argv = [
    ...original,
    "--foom-window-id=window-2",
    "--foom-window-number=2",
    "--foom-initial-session=terminal-1",
  ];
  try {
    const api = (await bridge()).windows;
    expect(api?.id).toBe("window-2");
    expect(api?.number).toBe(2);
    expect(api?.initialSession).toBe("terminal-1");
  } finally {
    process.argv = original;
  }
});

test("scrim notifications carry only validated visibility and unsubscribe", async () => {
  const api = await bridge();
  const receive = vi.fn();
  const off = api.confirmations.onScrim?.(receive);
  const listener = mock.on.mock.calls.at(-1)?.[1];
  listener?.({}, true);
  listener?.({}, false);
  listener?.({}, { title: "untrusted" });
  expect(receive.mock.calls).toEqual([[true], [false]]);
  off?.();
  expect(mock.removeListener).toHaveBeenCalledWith("confirmation:scrim", listener);
});
