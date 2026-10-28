import { DEFAULT_SETTINGS } from "../../../src/main/setup/settings";
import { malformedValues, withUndeclaredFields } from "./malformed-values";
import {
  replies,
  setup,
  config,
  requestId,
  previewId,
  scan,
  state,
  workspace,
  environment,
} from "./preload-fixtures";
import { BOARD_ACTIONS } from "../../../src/shared/board-commands";
import { createCommands } from "../../../src/main/window/commands";
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
  mock.invoke.mockImplementation((channel) =>
    Promise.resolve(typeof channel === "string" ? replies[channel] : undefined),
  );
});
async function bridge(keepListeners = false) {
  await import("../../../src/preload/preload");
  const api = mock.expose.mock.calls[0]?.[1];
  if (!api) throw new Error("Missing bridge");
  if (!keepListeners) mock.on.mockClear();
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
  await expect(api.workspace()).resolves.toEqual(replies["workspace:snapshot"]);
  await api.addRepository();
  await api.worktrees("/repos/app");
  await api.branches("/repos/app");
  await api.createWorktree("/repos/app", "feature", "root");
  await api.scanAgents(true);
  await api.changeAgentSetup("fixture", "install");
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
    ["workspace:branches", "/repos/app"],
    ["workspace:create-worktree", "/repos/app", "feature", "root"],
    ["agents:scan", true],
    ["agents:setup", "fixture", "install"],
    ["agents:agy-plugin", "install"],
    ["agents:launch", request],
    ["terminal:feedback", "t1", "v1", "dismissed"],
  ]);
});
test("setup requests use their own channels and never read a key back", async () => {
  const api = await bridge();
  await expect(api.listTerminalFonts()).resolves.toEqual(replies["setup:terminal-fonts"]);
  await expect(api.listTerminalFonts(true)).resolves.toEqual(replies["setup:terminal-fonts"]);
  await expect(api.listThemes()).resolves.toEqual(replies["theme:list"]);
  await api.openThemesFolder("theme");
  mock.invoke.mockResolvedValue({ settings: setup.settings, worktreeRoot: "/fixture" });
  await expect(api.setupState()).resolves.toEqual({
    settings: setup.settings,
    worktreeRoot: "/fixture",
  });
  await api.saveSetup({ hooks: false });
  expect(mock.invoke.mock.calls).toEqual([
    ["setup:terminal-fonts", false],
    ["setup:terminal-fonts", true],
    ["theme:list"],
    ["theme:open-folder", "theme"],
    ["setup:state"],
    ["setup:save", { hooks: false }],
  ]);
  expect(Object.keys(api).some((key) => /get.*key|read.*key/i.test(key))).toBe(false);
});
test("environment requests use their own channels and copy import names", async () => {
  const api = await bridge();
  const change = { scope: "all", previous: null, name: "A", value: "1", secret: false } as const;
  const names = ["HTTPS_PROXY"];
  await expect(api.environmentState()).resolves.toEqual(replies["environment:state"]);
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
  mock.invoke.mockResolvedValueOnce(scan);
  const pending = api.scanCode("s1", "/code", progress);
  expect(mock.invoke).toHaveBeenLastCalledWith("setup:scan-code", "s1", "/code");
  const listener = mock.on.mock.calls.find(([name]) => name === "setup:scan-progress")?.[1];
  if (!listener) throw new Error("Missing listener");
  listener({}, "s1", { folders: 3, repositories: 1 });
  listener({}, "other", { folders: 3, repositories: 1 });
  listener({}, "s1", { folders: "3", repositories: 1 });
  listener({}, "s1", null);
  await expect(pending).resolves.toEqual(scan);
  expect(progress).toHaveBeenCalledExactlyOnceWith({ folders: 3, repositories: 1 });
  expect(mock.removeListener).toHaveBeenCalledWith("setup:scan-progress", listener);
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
  const state = { settings: setup.settings, worktreeRoot: "/w" };
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
  handler?.(
    {},
    { ...state, verdictId: "v1", attentionKind: "question", inputRevision: 0, outputRevision: 2 },
  );
  handler?.({}, { ...state, attentionKind: "provider" });
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
    { ...state, attentionKind: {} },
    { ...state, attentionKind: "authorized" },
    { ...state, inputRevision: -1 },
    { ...state, outputRevision: "1" },
    { ...state, outputRevision: 1.5 },
  ])
    handler?.({}, bad);
  expect(callback.mock.calls).toEqual([
    [state],
    [{ ...state, verdictId: "v1", attentionKind: "question", inputRevision: 0, outputRevision: 2 }],
    [{ ...state, attentionKind: "provider" }],
  ]);
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
  handler?.({}, "toggle-sidebar");
  handler?.({}, "next-waiting");
  handler?.({}, "settings");
  handler?.({}, "foreign");
  handler?.({}, { command: "sidebar" });
  expect(callback.mock.calls).toEqual([
    ["sidebar"],
    ["toggle-sidebar"],
    ["next-waiting"],
    ["settings"],
  ]);
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
  navigate?.({}, "child", true);
  navigate?.({}, "normal", "true");
  expect(session.mock.calls).toEqual([["one"], ["child", true]]);
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
    "via-claude",
    "via-codex",
    "via-agy",
    "via-fixturecode",
    "tidy-tiles",
    "action-log",
  ])
    listener?.({}, command);
  listener?.({}, "reload");
  listener?.({}, {});
  listener?.({}, "preset-grid");
  expect(callback).toHaveBeenCalledTimes(8);
  off();
});

test("window capabilities forward IDs and validate view and audio notifications", async () => {
  const api = (await bridge()).windows;
  if (!api?.audio) throw new Error("Missing window capabilities");
  mock.invoke.mockResolvedValue([]);
  await api.sync(["a"]);
  mock.invoke.mockResolvedValueOnce(true);
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
test("Foom config calls pass fixed channels and status events are validated", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue(config);
  await api.configStatus();
  await api.decideConfig("keep", "f".repeat(64));
  await api.openConfigFolder();
  expect(mock.invoke.mock.calls.slice(-3)).toEqual([
    ["config:status"],
    ["config:decide", "keep", "f".repeat(64)],
    ["config:open-folder"],
  ]);
  const callback = vi.fn();
  const off = api.onConfigChange(callback);
  const listener = mock.on.mock.calls.find(([name]) => name === "config:changed")?.[1];
  if (!listener) throw new Error("Missing listener");
  const status = { folder: "/c", available: true, pending: null, rejected: [] };
  for (const value of [status, null, { ...status, folder: 1 }, { ...status, rejected: {} }])
    listener({}, value);
  expect(callback).toHaveBeenCalledExactlyOnceWith(status);
  off();
  expect(mock.removeListener).toHaveBeenCalledWith("config:changed", listener);
});

test("forwards action log queries and clearing through dedicated capabilities", async () => {
  const api = await bridge();
  const query = { search: "child", action: "reply", status: "indeterminate", offset: 0 };
  mock.invoke.mockResolvedValue({ entries: [], total: 0 });
  expect(await api.actionLog(query)).toEqual({ entries: [], total: 0 });
  await api.clearActionLog();
  expect(mock.invoke.mock.calls).toEqual([
    ["workspace:action-log", query],
    ["workspace:clear-action-log"],
  ]);
});

test("preview placement strips the event, acknowledges only the requested ID and disposes", async () => {
  const api = await bridge(true);
  mock.invoke.mockResolvedValue(undefined);
  const callback = vi.fn(() => Promise.resolve("landing" as const));
  const off = api.previews?.onPlace?.(callback);
  const listener = mock.on.mock.calls.find(([channel]) => channel === "preview:place")?.[1];
  if (!listener || !off) throw new Error("Missing placement bridge");
  const expiresAt = Date.now() + 5000;
  listener({}, requestId(0), "a".repeat(32), expiresAt);
  await vi.waitFor(() => {
    expect(mock.invoke).toHaveBeenCalledWith(
      "preview:placed",
      requestId(0),
      "a".repeat(32),
      "landing",
    );
  });
  expect(callback).toHaveBeenCalledWith("a".repeat(32), expiresAt);
  callback.mockRejectedValueOnce(new Error("renderer"));
  listener({}, requestId(1), "b".repeat(32), expiresAt);
  await Promise.resolve();
  await Promise.resolve();
  expect(mock.invoke).toHaveBeenCalledTimes(1);
  off();
  listener({}, requestId(2), "c".repeat(32), expiresAt);
  await Promise.resolve();
  expect(callback).toHaveBeenCalledTimes(2);
  const next = vi.fn(() => Promise.resolve("empty" as const));
  api.previews?.onPlace?.(next);
  await vi.waitFor(() => {
    expect(next).toHaveBeenCalledWith("c".repeat(32), expiresAt);
  });
});

test("preview network permission forwards only ID and desired state to main", async () => {
  const api = await bridge();
  await api.previews?.popout("preview");
  expect(mock.invoke).toHaveBeenCalledWith("preview:popout", "preview");
  await api.previews?.network("preview", true);
  expect(mock.invoke).toHaveBeenCalledWith("preview:network", "preview", true);
});

test("preview picker sends only the inventory worktree ID; bounds and close send preview IDs", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue("preview");
  await api.previews?.pick("/checkout");
  const bounds = { x: 1, y: 2, width: 300, height: 200, visible: true };
  await api.previews?.bounds("preview", bounds);
  await api.previews?.reload("preview");
  await api.previews?.close("preview");
  expect(mock.invoke.mock.calls).toEqual([
    ["preview:pick", "/checkout"],
    ["preview:bounds", "preview", bounds],
    ["preview:reload", "preview"],
    ["preview:close", "preview"],
  ]);
  expect(api.previews).not.toHaveProperty("open");
});

test("preview cover and snapshots expose only validated image pixels and geometry", async () => {
  const api = (await bridge()).previews;
  if (!api) throw new Error("Missing preview API");
  mock.invoke.mockResolvedValue(undefined);
  await api.cover(true);
  expect(mock.invoke).toHaveBeenCalledWith("preview:cover", true);
  const callback = vi.fn();
  const off = api.onSnapshots(callback);
  const listener = mock.on.mock.calls.find(([channel]) => channel === "preview:snapshots")?.[1];
  if (!listener) throw new Error("Missing snapshots listener");
  const entry = {
    id: "a".repeat(32),
    bounds: { x: 0, y: 1, width: 2, height: 3, visible: true },
    image: "data:image/png;base64,AA==",
    version: 1,
  };
  listener({}, [entry]);
  expect(callback).toHaveBeenLastCalledWith([entry]);
  await api.painted(entry.id, 1);
  expect(mock.invoke).toHaveBeenLastCalledWith("preview:painted", entry.id, 1);
  callback.mockClear();
  for (const value of [
    null,
    {},
    Array.from({ length: 257 }, () => entry),
    [null],
    [{ ...entry, id: 1 }],
    [{ ...entry, id: "wrong" }],
    [{ ...entry, bounds: null }],
    ...[undefined, "1", 0, -1, 1.5, NaN].map((version) => [{ ...entry, version }]),
    [{ ...entry, image: 1 }],
    [{ ...entry, image: "https://example.com" }],
    ...["x", "y", "width", "height"].flatMap((key) =>
      ["1", NaN].map((n) => [{ ...entry, bounds: { ...entry.bounds, [key]: n } }]),
    ),
    [{ ...entry, bounds: { ...entry.bounds, visible: "true" } }],
  ])
    listener({}, value);
  expect(callback).not.toHaveBeenCalled();
  listener({}, []);
  expect(callback).toHaveBeenCalledWith([]);
  off();
  expect(mock.removeListener).toHaveBeenCalledWith("preview:snapshots", listener);
});

test("preview placement waits for board mount, expires stale requests and bounds the startup queue", async () => {
  const api = await bridge(true);
  mock.invoke.mockResolvedValue(undefined);
  const listener = mock.on.mock.calls.find(([channel]) => channel === "preview:place")?.[1];
  if (!listener) throw new Error("Missing placement listener");
  const expiresAt = Date.now() + 5000;
  listener({}, requestId(3), previewId(), Date.now() - 1);
  listener({}, requestId(4), previewId(), Date.now() + 1);
  // Advance the clock without a real delay or a product/test deadline change.
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2);
  for (let i = 0; i < 257; i++) listener({}, requestId(i + 10), previewId(i + 10), expiresAt);
  expect(mock.invoke).not.toHaveBeenCalled();
  const callback = vi.fn(() => Promise.resolve("empty" as const));
  const off = api.previews?.onPlace?.(callback);
  await vi.waitFor(() => {
    expect(callback).toHaveBeenCalledTimes(256);
  });
  expect(callback).toHaveBeenNthCalledWith(1, previewId(10), expiresAt);
  expect(callback).toHaveBeenLastCalledWith(previewId(265), expiresAt);
  const next = vi.fn(() => Promise.resolve("landing" as const));
  api.previews?.onPlace?.(next);
  off?.();
  listener({}, requestId(5), previewId(300), expiresAt);
  await vi.waitFor(() => {
    expect(next).toHaveBeenCalledWith(previewId(300), expiresAt);
  });
  now.mockRestore();
});

test("every main board action crosses the preload", async () => {
  const api = await bridge();
  const callback = vi.fn<(command: string) => void>();
  api.onBoardCommand(callback);
  const listener = mock.on.mock.calls.find(([channel]) => channel === "board:command")?.[1];
  const board = vi.fn<(command: string) => void>();
  const commands = createCommands("linux", true, {
    board,
    zoom: vi.fn(),
    // The main-owned Manual action selects its preview before revealing the board.
    native: (id) => {
      if (id === "manual") board("manual");
    },
  });
  for (const command of commands) await command.run();
  const emitted = board.mock.calls.map(([command]) => command);
  expect(new Set(emitted)).toEqual(new Set(BOARD_ACTIONS));
  for (const command of emitted) listener?.({}, command);
  expect(callback.mock.calls.map(([command]) => command)).toEqual(emitted);
  for (const invalid of [
    "via-",
    "via-UPPER",
    "via-a".padEnd(46, "a"),
    "via-a\n",
    "unknown",
    null,
    {},
    1,
  ])
    listener?.({}, invalid);
  expect(callback).toHaveBeenCalledTimes(emitted.length);
});

test("validates bounded application and Electron versions", async () => {
  const api = await bridge();
  for (const value of [
    null,
    {},
    { app: 1 },
    { app: "1" },
    { app: "1", electron: 4 },
    { app: "<script>", electron: "44" },
    { app: "1", electron: "x" },
    { app: "1".repeat(129), electron: "44" },
  ]) {
    mock.invoke.mockResolvedValue(value);
    await expect(api.appMenu.version()).rejects.toThrow("Invalid application version");
  }
  mock.invoke.mockResolvedValue({ app: "0.1.0-nightly.20261021+abc1234", electron: "44.4.5" });
  await expect(api.appMenu.version()).resolves.toEqual({
    app: "0.1.0-nightly.20261021+abc1234",
    electron: "44.4.5",
  });
});

test("readiness only publishes fixed categories and bounded DNS hostnames", async () => {
  const api = await bridge();
  const valid = {
    git: "ready",
    platform: "linux",
    forges: [{ host: "github.com", status: "not-signed-in" }],
  };
  mock.invoke.mockResolvedValue(valid);
  await expect(api.checkReadiness()).resolves.toEqual(valid);
  expect(mock.invoke).toHaveBeenCalledWith("setup:readiness");
  for (const value of [
    null,
    { ...valid, git: "private output" },
    { ...valid, git: ["ready"] },
    { ...valid, platform: ["linux"] },
    { ...valid, forges: [{ host: "github.com", status: ["ready"] }] },
    { ...valid, platform: "freebsd" },
    { ...valid, extra: "secret" },
    { ...valid, forges: [{ host: "bad host", status: "ready" }] },
    { ...valid, forges: [{ host: "github.com", status: "private" }] },
    { ...valid, forges: [{ host: "github.com", status: "ready", stderr: "secret" }] },
    { ...valid, forges: Array(1001).fill({ host: "github.com", status: "ready" }) },
  ]) {
    mock.invoke.mockResolvedValue(value);
    await expect(api.checkReadiness()).rejects.toThrow("Invalid readiness response");
  }
});

test("legal bridge validates fixed IDs, bounded text, notifications and disposal", async () => {
  const api = await bridge();
  for (const id of [null, {}, "../../LICENSE", "github"]) {
    await expect(Reflect.apply(api.appMenu.legal, undefined, [id])).rejects.toThrow(
      "Invalid legal document",
    );
  }
  expect(mock.invoke).not.toHaveBeenCalled();
  for (const value of [null, {}, 1, "", "x".repeat(1_048_577)]) {
    mock.invoke.mockResolvedValue(value);
    await expect(api.appMenu.legal("notices")).rejects.toThrow("Invalid bundled legal text");
  }
  mock.invoke.mockResolvedValue("<script>inert legal text</script>");
  await expect(api.appMenu.legal("licenses")).resolves.toBe("<script>inert legal text</script>");
  expect(mock.invoke).toHaveBeenLastCalledWith("app-menu:legal", "licenses");
  const callback = vi.fn();
  const off = api.appMenu.onLegal(callback);
  const listener = mock.on.mock.calls.find(([channel]) => channel === "app-menu:legal")?.[1];
  for (const id of [null, {}, "../../LICENSE", "licenses", "notices"]) listener?.({}, id);
  expect(callback.mock.calls).toEqual([["licenses"], ["notices"]]);
  off();
  expect(mock.removeListener).toHaveBeenCalledWith("app-menu:legal", listener);
});

test("update status rejects remote text and malformed agent counts", async () => {
  const api = await bridge();
  const changed = vi.fn();
  api.onSetupChange(changed);
  const listener = mock.on.mock.calls.find(([name]) => name === "setup:changed")?.[1];
  for (const updates of [
    { status: "downloaded", runningAgents: 2 },
    { status: "idle", runningAgents: 0 },
  ])
    listener?.({}, { settings: setup.settings, worktreeRoot: "/fixture", updates });
  for (const updates of [
    { status: "remote message", runningAgents: 0 },
    { status: "downloaded", runningAgents: -1 },
    { status: "idle", runningAgents: 0.5 },
    null,
    { status: "error", runningAgents: "3" },
  ])
    listener?.({}, { settings: setup.settings, worktreeRoot: "/fixture", updates });
  expect(changed).toHaveBeenCalledTimes(2);
  await api.restartToUpdate();
  expect(mock.invoke).toHaveBeenCalledWith("setup:restart-update");
});

test("initial and saved setup responses validate update facts too", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue({
    settings: setup.settings,
    worktreeRoot: "/fixture",
    updates: { status: "secret", runningAgents: 2 },
  });
  await expect(api.setupState()).rejects.toThrow("Invalid setup response");
  await expect(api.saveSetup({ checkForUpdates: false })).rejects.toThrow("Invalid setup response");
});

const invokeReply: Record<string, (api: DesktopApi) => Promise<unknown>> = {
  "workspace:snapshot": (api) => api.workspace(),
  "workspace:add-repository": (api) => api.addRepository(),
  "workspace:worktrees": (api) => api.worktrees("/repo"),
  "workspace:branches": (api) => api.branches("/repo"),
  "workspace:create-worktree": (api) => api.createWorktree("/repo", "feature"),
  "workspace:sidebar": (api) => api.sidebarInventory(),
  "workspace:start": (api) =>
    api.startWorktree({ repository: "/repo", branch: "feature", run: "codex" }),
  "workspace:remove": (api) => api.removeWorktree("one"),
  "workspace:panel-facts": (api) => api.panelFacts("/repo", "/worktrees/feature"),
  "workspace:action-log": (api) => api.actionLog({ search: "", action: "", status: "", offset: 0 }),
  "agents:scan": (api) => api.scanAgents(false),
  "agents:setup": (api) => api.changeAgentSetup("codex", "update"),
  "agents:agy-plugin": (api) => api.changeAgyPlugin("update"),
  "agents:launch": (api) =>
    api.launchAgent({
      agent: "codex",
      repository: "/repo",
      worktree: "/worktrees/feature",
      cols: 80,
      rows: 24,
    }),
  "setup:state": (api) => api.setupState(),
  "setup:save": (api) => api.saveSetup({}),
  "setup:terminal-fonts": (api) => api.listTerminalFonts(),
  "theme:list": (api) => api.listThemes(),
  "config:status": (api) => api.configStatus(),
  "config:decide": (api) => api.decideConfig("keep", "digest"),
  "environment:state": (api) => api.environmentState(),
  "environment:save": (api) =>
    api.saveEnvironment({
      scope: "all",
      previous: null,
      name: "NO_PROXY",
      value: "localhost",
      secret: false,
    }),
  "environment:remove": (api) => api.removeEnvironment("all", "NO_PROXY"),
  "environment:import": (api) => api.importEnvironment(["HTTPS_PROXY"]),
  "environment:read-shell": (api) => api.readShellEnvironment(),
  "setup:scan-code": (api) => api.scanCode("scan", "/code", vi.fn()),
  "setup:code-suggestions": (api) => api.codeSuggestions(),
  "setup:apply-repositories": (api) => api.applyRepositories(["/repo"]),
  "sound:list": (api) => api.sounds.list(),
  "sound:read": (api) => api.sounds.read({ kind: "done", source: "builtin", file: "bell.ogg" }),
  "sound:notices": (api) => api.sounds.notices(),
  "app-menu:list": (api) => api.appMenu.commands(),
  "app-menu:shortcuts": (api) => api.appMenu.shortcuts(),
  "windows:sync": async (api) => api.windows?.sync(["one"]),
  "windows:select": async (api) => api.windows?.select("one"),
  "preview:pick": async (api) => api.previews?.pick("/worktrees/feature"),
};

test.each(Object.entries(invokeReply))(
  "%s checks every nested reply field before resolving",
  async (channel, call) => {
    const api = await bridge();
    const valid = replies[channel];
    mock.invoke.mockResolvedValue(valid);
    await expect(call(api)).resolves.toEqual(valid);
    for (const bad of malformedValues(valid)) {
      mock.invoke.mockResolvedValue(bad.value);
      await expect(call(api), bad.path).rejects.toThrow(/Invalid/);
    }
    mock.invoke.mockResolvedValue(undefined);
    await expect(call(api)).rejects.toThrow(/Invalid/);
    mock.invoke.mockRejectedValue(new Error("Main rejected"));
    await expect(call(api)).rejects.toThrow("Main rejected");
  },
);

test("setup, config and terminal events apply the same complete nested contracts", async () => {
  const api = await bridge();
  for (const [channel, subscribe, valid] of [
    ["setup:changed", (cb: (value: unknown) => void) => api.onSetupChange(cb), setup],
    ["config:changed", (cb: (value: unknown) => void) => api.onConfigChange(cb), config],
    ["terminal:state", (cb: (value: unknown) => void) => api.onState(cb), state],
  ] as const) {
    const callback = vi.fn();
    const off = subscribe(callback);
    const listener = mock.on.mock.calls.find(([name]) => name === channel)?.[1];
    if (!listener) throw Error("Missing event");
    listener({}, valid);
    expect(callback).toHaveBeenCalledExactlyOnceWith(valid);
    callback.mockClear();
    for (const bad of malformedValues(valid)) listener({}, bad.value);
    expect(callback).not.toHaveBeenCalled();
    off();
  }
});

test("placement rejects malformed envelopes before buffering or calling the board", async () => {
  const api = await bridge(true);
  const listener = mock.on.mock.calls.find(([name]) => name === "preview:place")?.[1];
  if (!listener) throw Error("Missing placement listener");
  const valid = [requestId(), previewId(), Date.now() + 5000];
  const invalid = [
    ...[null, {}, "", "request", 1].map((request) => [request, valid[1], valid[2]]),
    ...[null, {}, "", "z".repeat(32), 1].map((id) => [valid[0], id, valid[2]]),
    ...[null, {}, "1", NaN, Infinity, -Infinity, -1, 1.5, Date.now() - 1].map((expiry) => [
      valid[0],
      valid[1],
      expiry,
    ]),
  ];
  for (const envelope of invalid) listener({}, ...envelope);
  const callback = vi.fn(() => Promise.resolve("landing" as const));
  api.previews?.onPlace?.(callback);
  for (const envelope of invalid) listener({}, ...envelope);
  await Promise.resolve();
  expect(callback).not.toHaveBeenCalled();
  expect(mock.invoke).not.toHaveBeenCalled();
  listener({}, ...valid);
  await vi.waitFor(() => {
    expect(callback).toHaveBeenCalledOnce();
  });
});

test("scan progress rejects nonfinite, fractional and negative counts", async () => {
  const api = await bridge();
  const progress = vi.fn();
  const pending = api.scanCode("scan", "/code", progress);
  const listener = mock.on.mock.calls.find(([name]) => name === "setup:scan-progress")?.[1];
  for (const key of ["folders", "repositories"])
    for (const value of [NaN, Infinity, -Infinity, -1, 1.5])
      listener?.({}, "scan", { folders: 1, repositories: 1, [key]: value });
  listener?.({}, "scan", { folders: 0, repositories: 0 });
  await pending;
  expect(progress).toHaveBeenCalledExactlyOnceWith({ folders: 0, repositories: 0 });
});

test("missing required settings and config fields reject both reads and notifications", async () => {
  const api = await bridge();
  const changed = vi.fn();
  const configured = vi.fn();
  api.onSetupChange(changed);
  api.onConfigChange(configured);
  const setupEvent = mock.on.mock.calls.find(([name]) => name === "setup:changed")?.[1];
  const configEvent = mock.on.mock.calls.find(([name]) => name === "config:changed")?.[1];
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const settings = Object.fromEntries(
      Object.entries(setup.settings).filter(([name]) => name !== key),
    );
    const value = { ...setup, settings };
    mock.invoke.mockResolvedValue(value);
    await expect(api.setupState(), key).rejects.toThrow("Invalid setup response");
    await expect(api.saveSetup({}), key).rejects.toThrow("Invalid setup response");
    setupEvent?.({}, value);
  }
  for (const key of ["folder", "available", "pending", "rejected"]) {
    const value = Object.fromEntries(Object.entries(config).filter(([name]) => name !== key));
    mock.invoke.mockResolvedValue(value);
    await expect(api.configStatus(), key).rejects.toThrow(/Invalid/);
    await expect(api.decideConfig("keep", "digest"), key).rejects.toThrow(/Invalid/);
    configEvent?.({}, value);
  }
  expect(changed).not.toHaveBeenCalled();
  expect(configured).not.toHaveBeenCalled();
});

test("unknown enums and out-of-range settings never enter setup state", async () => {
  const api = await bridge();
  for (const patch of [
    { worktreeLocation: "unknown" },
    { panelColor: "unknown" },
    { colorMode: "unknown" },
    { interfaceTheme: "unknown" },
    { terminalTheme: "unknown" },
    ...[0, 17, 1.5].map((concurrentChildren) => ({ concurrentChildren })),
    ...[0, 366, 1.5].map((recentRepositoryDays) => ({ recentRepositoryDays })),
    ...[-1, 1441, 1.5].map((unreadChildMinutes) => ({ unreadChildMinutes })),
    ...[9, 33, 14.5].map((terminalFontSize) => ({ terminalFontSize })),
    ...[0, 85, 151, 301].map((interfaceScale) => ({ interfaceScale })),
    ...[-0.1, 1.1].map((volume) => ({ sound: { ...setup.settings.sound, volume } })),
    {
      sound: {
        ...setup.settings.sound,
        choices: { ...setup.settings.sound.choices, done: { source: "remote", file: "bell.wav" } },
      },
    },
  ]) {
    mock.invoke.mockResolvedValue({ ...setup, settings: { ...setup.settings, ...patch } });
    await expect(api.setupState()).rejects.toThrow("Invalid setup response");
  }
  mock.invoke.mockResolvedValue({ settings: DEFAULT_SETTINGS, worktreeRoot: "/worktrees" });
  await expect(api.setupState()).resolves.toEqual({
    settings: DEFAULT_SETTINGS,
    worktreeRoot: "/worktrees",
  });
  for (const choice of ["user:custom.json", "eclipse-light", "follow"] as const) {
    mock.invoke.mockResolvedValue({
      ...setup,
      settings: { ...setup.settings, interfaceTheme: choice, terminalTheme: "user:custom.json" },
    });
    await expect(api.setupState()).resolves.toBeDefined();
  }
});

test("nullable replies and alternate union branches remain valid", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue(null);
  await expect(api.addRepository()).resolves.toBeNull();
  await expect(
    api.startWorktree({ repository: "/repo", branch: "feature", run: "codex" }),
  ).resolves.toBeNull();
  await expect(
    api.launchAgent({
      repository: "/repo",
      worktree: "/worktree",
      agent: "codex",
      cols: 80,
      rows: 24,
    }),
  ).resolves.toBeNull();
  await expect(api.previews?.pick("/worktree")).resolves.toBeNull();
  await expect(api.scanCode("scan", null, vi.fn())).resolves.toBeNull();
  mock.invoke.mockResolvedValue({ error: "Unavailable" });
  await expect(
    api.sounds.read({ kind: "done", source: "user", file: "bell.wav" }),
  ).resolves.toEqual({ error: "Unavailable" });
  const snapshot = {
    ...workspace,
    terminals: workspace.terminals.map((terminal) => ({
      ...terminal,
      state: null,
      orchestration: { role: "child", parentId: "parent", takenOver: false },
      handoff: {
        ...terminal.handoff,
        seq: 1,
        status: "done",
        summary: "Done",
        links: [],
        timestamp: "now",
        review: { verdict: "clean" },
      },
    })),
  };
  mock.invoke.mockResolvedValue(snapshot);
  await expect(api.workspace()).resolves.toEqual(snapshot);
});

test("rejects sparse arrays and malformed optional event flags", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue(new Array(1));
  await expect(api.listTerminalFonts()).rejects.toThrow(/Invalid/);
  await expect(api.tail("one", 1)).rejects.toThrow(/Invalid/);
  const changed = vi.fn();
  api.onTerminalAvailability(changed);
  api.appMenu.onSession(changed);
  api.confirmations.subscribe(changed);
  for (const [channel, args] of [
    ["terminal:availability", [["one"], true, "true"]],
    ["app-menu:session", ["one", "true"]],
    ["confirmation:armed", [null, "true"]],
  ] as const)
    mock.on.mock.calls.find(([name]) => name === channel)?.[1]({}, ...args);
  expect(changed).not.toHaveBeenCalled();
});

test("bounded sound bytes and window IDs reject malformed data", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue({ bytes: new Uint8Array(8 * 1024 * 1024 + 1) });
  await expect(
    api.sounds.read({ kind: "working", source: "user", file: "loop.ogg" }),
  ).rejects.toThrow(/Invalid/);
  const changed = vi.fn();
  api.windows?.onChanged(changed);
  api.windows?.audio?.onChanged(changed);
  const views = mock.on.mock.calls.find(([name]) => name === "windows:changed")?.[1];
  const audio = mock.on.mock.calls.find(([name]) => name === "windows:audio")?.[1];
  views?.({}, [{ id: "", window: 1 }]);
  views?.({}, [{ id: "one", window: -1 }]);
  views?.({}, new Array(1));
  audio?.({}, { enabled: true, focusedId: "" });
  expect(changed).not.toHaveBeenCalled();
});

test("a secret row carrying plaintext cannot cross the environment response boundary", async () => {
  const api = await bridge();
  const value = {
    ...environment,
    lists: {
      ...environment.lists,
      all: [{ name: "HTTPS_PROXY", secret: true, value: "must stay in main" }],
    },
  };
  mock.invoke.mockResolvedValue(value);
  await expect(api.environmentState()).rejects.toThrow(/Invalid/);
});

test("sound replies cannot claim both the byte and error branches", async () => {
  const api = await bridge();
  for (const value of [
    { bytes: new Uint8Array([1]), error: "Unavailable" },
    { bytes: 42, error: "Unavailable" },
    { bytes: undefined, error: "Unavailable" },
    { bytes: new Uint8Array([1]), error: 42 },
    { error: 42 },
  ]) {
    mock.invoke.mockResolvedValue(value);
    await expect(
      api.sounds.read({ kind: "done", source: "user", file: "bell.wav" }),
    ).rejects.toThrow(/Invalid/);
  }
});

test.each(Object.entries(invokeReply))(
  "%s reconstructs validated replies without undeclared nested data",
  async (channel, call) => {
    const api = await bridge();
    const dictionaries = new Set([
      "$.settings.agentHooks",
      "$.settings.forges",
      "$.settings.forgeHosts",
      "$.settings.agents",
      "$.settings.agentArguments",
      "$.settings.agentBypassAcknowledged",
      "$.lists",
    ]);
    const valid = replies[channel];
    const injected = withUndeclaredFields(valid, dictionaries);
    mock.invoke.mockResolvedValue(injected);
    const published = await call(api);
    expect(published).toStrictEqual(valid);
    if (valid !== null && typeof valid === "object") expect(published).not.toBe(injected);
  },
);

test("reconstructs the error branch of a sound reply", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue({ error: "Unavailable", unexpected: {}, ["__proto__"]: {} });
  await expect(
    api.sounds.read({ kind: "done", source: "user", file: "bell.wav" }),
  ).resolves.toStrictEqual({ error: "Unavailable" });
});

test("validates requested child selections in session replies", async () => {
  const api = await bridge();
  const terminal = workspace.terminals[0];
  if (!terminal) throw new Error("Missing fixture terminal");
  const selection = { model: "fixture/model", effort: "high" };
  mock.invoke.mockResolvedValue({ ...workspace, terminals: [{ ...terminal, selection }] });
  expect((await api.workspace()).terminals[0]?.selection).toEqual(selection);
  mock.invoke.mockResolvedValue({
    ...workspace,
    terminals: [{ ...terminal, selection: { model: "-bad" } }],
  });
  await expect(api.workspace()).rejects.toThrow();
});

test("terminal selection copy exposes a write-only ID-scoped bridge", async () => {
  const api = await bridge();
  mock.invoke.mockResolvedValue(undefined);
  await api.copyTerminalSelection("one", "selected");
  expect(mock.invoke).toHaveBeenCalledExactlyOnceWith("terminal:copy-selection", "one", "selected");
});

test.each([{ kind: "local" }, { kind: "remote", host: "fixture-alias" }])(
  "projects actual placement across the sandbox bridge: %j",
  async (placement) => {
    const api = await bridge();
    const row = workspace.terminals[0];
    if (!row) throw new Error("Missing fixture row");
    const value = {
      ...workspace,
      terminals: [{ ...row, placement, remoteCleanup: "unreachable" }],
    };
    mock.invoke.mockResolvedValue(value);
    await expect(api.workspace()).resolves.toEqual(value);
    for (const bad of ["-oBad", "host\nprivate", "a".repeat(254), 1]) {
      mock.invoke.mockResolvedValue({
        ...workspace,
        terminals: [{ ...row, placement: { kind: "remote", host: bad } }],
      });
      await expect(api.workspace()).rejects.toThrow("Invalid");
    }
  },
);
