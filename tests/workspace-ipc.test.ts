import { beforeEach, expect, test, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { Workspace } from "../src/workspace";

const mock = vi.hoisted(() => ({
  handle:
    vi.fn<(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void>(),
  removeHandler: vi.fn(),
  showOpenDialog: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: mock.handle, removeHandler: mock.removeHandler },
  dialog: { showOpenDialog: mock.showOpenDialog },
}));
import { attachWorkspace } from "../src/workspace-ipc";

const frame = { url: "app://bundle/index.html" };
const contents = { isDestroyed: vi.fn(() => false), mainFrame: frame, send: vi.fn() };
const window = { webContents: contents } as unknown as BrowserWindow;
const trusted = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
const workspace = {
  snapshot: vi.fn(() => ({ repositories: [], terminals: [] })),
  addRepository: vi.fn((path: string) => Promise.resolve({ path, name: "app" })),
  worktrees: vi.fn(() => Promise.resolve([])),
  createWorktree: vi.fn(() => Promise.resolve({ path: "/t" })),
  scanAgents: vi.fn(() => Promise.resolve({ warning: null, agents: [] })),
  launch: vi.fn((_request: unknown) => Promise.resolve({ id: "t1", attention: "evaluator" })),
  feedback: vi.fn(() => Promise.resolve()),
};
const owns = vi.fn((id: string) => id === "t1");
let attached: ReturnType<typeof attachWorkspace>;

beforeEach(() => {
  vi.clearAllMocks();
  contents.isDestroyed.mockReturnValue(false);
  frame.url = "app://bundle/index.html";
  attached = attachWorkspace(window, workspace as unknown as Workspace, owns);
});

function invoke(channel: string, args: unknown[] = [], event: unknown = trusted) {
  const handler = mock.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (!handler) throw new Error(`Missing ${channel}`);
  return handler(event, ...args);
}

test("rejects untrusted senders on every channel", () => {
  const channels = mock.handle.mock.calls.map(([name]) => name);
  expect(channels).toEqual([
    "workspace:snapshot",
    "workspace:add-repository",
    "workspace:worktrees",
    "workspace:create-worktree",
    "agents:scan",
    "agents:launch",
    "terminal:feedback",
  ]);
  const other = { sender: {}, senderFrame: frame };
  const subframe = { sender: contents, senderFrame: { url: frame.url } };
  const noFrame = { sender: contents, senderFrame: null };
  for (const channel of channels)
    for (const event of [other, subframe, noFrame])
      expect(() => invoke(channel, [], event)).toThrow("Untrusted IPC sender");
  expect(workspace.snapshot).not.toHaveBeenCalled();
});

test("main picks repository paths with the native dialog", async () => {
  mock.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: ["/ignored"] });
  await expect(invoke("workspace:add-repository", ["/renderer/choice"])).resolves.toBeNull();
  mock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
  await expect(invoke("workspace:add-repository")).resolves.toBeNull();
  mock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/repos/app"] });
  await expect(invoke("workspace:add-repository", ["/renderer/choice"])).resolves.toEqual({
    path: "/repos/app",
    name: "app",
  });
  expect(workspace.addRepository).toHaveBeenCalledExactlyOnceWith("/repos/app");
});

test("validates worktree and scan arguments before calling the workspace", async () => {
  invoke("workspace:snapshot");
  expect(workspace.snapshot).toHaveBeenCalledOnce();
  await invoke("workspace:worktrees", ["/repos/app"]);
  expect(workspace.worktrees).toHaveBeenCalledWith("/repos/app");
  for (const bad of [undefined, "", 7, "a\0b", "x".repeat(4097)])
    expect(() => invoke("workspace:worktrees", [bad])).toThrow("Invalid repository");

  await invoke("workspace:create-worktree", ["/repos/app", "feature/x", "adjacent"]);
  expect(workspace.createWorktree).toHaveBeenCalledWith("/repos/app", "feature/x", "adjacent");
  for (const args of [
    ["/repos/app", "b", "elsewhere"],
    ["/repos/app", "", "root"],
    ["/repos/app", "x".repeat(256), "root"],
    [null, "b", "root"],
  ])
    expect(() => invoke("workspace:create-worktree", args)).toThrow("Invalid worktree request");

  await invoke("agents:scan", [true]);
  expect(workspace.scanAgents).toHaveBeenCalledWith(true);
  expect(() => invoke("agents:scan", ["yes"])).toThrow("Invalid scan request");
});

test("launch requests are validated and copied field by field", async () => {
  const request = {
    agent: "codex",
    repository: "/repos/app",
    worktree: "/trees/app/x",
    cols: 80,
    rows: 24,
    acknowledgeCodexNotifierReplacement: true,
    command: "/bin/evil",
    args: ["--danger"],
  };
  await invoke("agents:launch", [request]);
  expect(workspace.launch).toHaveBeenCalledWith({
    agent: "codex",
    repository: "/repos/app",
    worktree: "/trees/app/x",
    cols: 80,
    rows: 24,
    acknowledgeCodexNotifierReplacement: true,
  });
  const plain: Record<string, unknown> = { ...request };
  delete plain["acknowledgeCodexNotifierReplacement"];
  await invoke("agents:launch", [plain]);
  expect(workspace.launch.mock.lastCall?.[0]).not.toHaveProperty(
    "acknowledgeCodexNotifierReplacement",
  );
  for (const bad of [
    null,
    [],
    "claude",
    { ...plain, agent: "bash" },
    { ...plain, repository: "" },
    { ...plain, worktree: 3 },
    { ...plain, cols: 1 },
    { ...plain, rows: 301 },
    { ...plain, cols: 80.5 },
    { ...plain, acknowledgeCodexNotifierReplacement: "yes" },
  ])
    expect(() => invoke("agents:launch", [bad])).toThrow("Invalid launch request");
});

test("feedback only applies to owned terminals and known actions", async () => {
  await invoke("terminal:feedback", ["t1", "v1", "dismissed"]);
  expect(workspace.feedback).toHaveBeenCalledWith("t1", "v1", "dismissed");
  // Null names the current verdict when it couldn't be stored.
  await invoke("terminal:feedback", ["t1", null, "dismissed"]);
  expect(workspace.feedback).toHaveBeenLastCalledWith("t1", null, "dismissed");
  for (const args of [
    ["t1", undefined, "dismissed"],
    ["t2", "v1", "dismissed"],
    ["t1", "", "dismissed"],
    ["t1", "v".repeat(129), "replied"],
    ["t1", "v1", "approved"],
    [1, "v1", "ignored"],
  ])
    await expect(invoke("terminal:feedback", args)).rejects.toThrow("Invalid feedback");
});

test("state goes only to the app document for owned terminals", () => {
  const state = {
    id: "t1",
    verdictId: "v1",
    state: "done" as const,
    reason: "r",
    signal: "s",
    confidence: 1,
    timestamp: 1,
  };
  attached.sendState(state);
  expect(contents.send).toHaveBeenCalledWith("terminal:state", state);
  attached.sendState({ ...state, id: "t2" });
  frame.url = "https://example.com/";
  attached.sendState(state);
  frame.url = "app://bundle/index.html";
  contents.isDestroyed.mockReturnValue(true);
  attached.sendState(state);
  expect(contents.send).toHaveBeenCalledOnce();
});

test("dispose removes every handler", () => {
  attached.dispose();
  expect(mock.removeHandler.mock.calls.map(([name]: unknown[]) => name)).toEqual(
    mock.handle.mock.calls.map(([name]) => name),
  );
});

test("workspace invalidations go only to the app document", () => {
  attached.sendChanged();
  expect(contents.send).toHaveBeenCalledWith("workspace:changed");
  frame.url = "https://example.com";
  attached.sendChanged();
  frame.url = "app://bundle/index.html";
  contents.isDestroyed.mockReturnValue(true);
  attached.sendChanged();
  expect(contents.send).toHaveBeenCalledOnce();
});
