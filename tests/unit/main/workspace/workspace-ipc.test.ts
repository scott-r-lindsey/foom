import type { ConfirmWorkspace } from "../../../../src/shared/confirmation";
import { beforeEach, expect, test, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { Workspace } from "../../../../src/main/workspace/workspace";

const mock = vi.hoisted(() => ({
  handle:
    vi.fn<(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void>(),
  removeHandler: vi.fn(),
  showMessageBox: vi.fn<() => Promise<{ response: number }>>(),
  showOpenDialog: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(),
}));
vi.mock("electron", () => ({
  ipcMain: { handle: mock.handle, removeHandler: mock.removeHandler },
  dialog: { showOpenDialog: mock.showOpenDialog, showMessageBox: mock.showMessageBox },
}));
import { attachWorkspace } from "../../../../src/main/workspace/workspace-ipc";

const frame = { url: "app://bundle/index.html" };
const contents = {
  on: vi.fn(),
  removeListener: vi.fn(),
  isDestroyed: vi.fn(() => false),
  mainFrame: frame,
  send: vi.fn(),
};
const window = { webContents: contents } as unknown as BrowserWindow;
const trusted = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
const workspace = {
  ownsSession: vi.fn((id: string) => id === "restored"),
  startWorktree: vi.fn(() => Promise.resolve("t1")),
  removeWorktree: vi.fn(
    (_id: string, confirm: (branch: string, changes: string) => Promise<boolean>) =>
      confirm("feature", "?? notes.txt\0"),
  ),
  snapshot: vi.fn(() => ({ repositories: [], terminals: [] })),
  addRepository: vi.fn((path: string) => Promise.resolve({ path, name: "app" })),
  worktrees: vi.fn(() => Promise.resolve([])),
  createWorktree: vi.fn(() => Promise.resolve({ path: "/t" })),
  scanAgents: vi.fn(() => Promise.resolve({ warning: null, agents: [] })),
  launch: vi.fn((_request: unknown) => Promise.resolve({ id: "t1", attention: "evaluator" })),
  feedback: vi.fn(() => Promise.resolve()),
};
const requestDialog = vi.fn<() => Promise<boolean>>();
const owns = vi.fn((id: string) => id === "t1");
let attached: ReturnType<typeof attachWorkspace>;

beforeEach(() => {
  vi.clearAllMocks();
  contents.isDestroyed.mockReturnValue(false);
  frame.url = "app://bundle/index.html";
  attached = attachWorkspace(window, workspace as unknown as Workspace, owns, requestDialog);
});

function invoke(channel: string, args: unknown[] = [], event: unknown = trusted) {
  const handler = mock.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (!handler) throw new Error(`Missing ${channel}`);
  return handler(event, ...args);
}

test("rejects untrusted senders on every channel", () => {
  const channels = mock.handle.mock.calls.map(([name]) => name);
  expect(channels).toEqual([
    "confirmation:confirm",
    "confirmation:cancel",
    "workspace:start",
    "workspace:remove",
    "workspace:sidebar",
    "workspace:sidebar-command",
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
  expect(workspace.launch).toHaveBeenCalledWith(
    {
      agent: "codex",
      repository: "/repos/app",
      worktree: "/trees/app/x",
      cols: 80,
      rows: 24,
      acknowledgeCodexNotifierReplacement: true,
    },
    expect.any(Function),
  );
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

test("launch accepts names only and rejects malformed or injected payloads", async () => {
  const request = {
    repository: "/repos/app",
    branch: "feature",
    run: "shell",
    acknowledgeCodexNotifierReplacement: false,
  };
  await invoke("workspace:start", [{ ...request, command: "/bad", cwd: "/bad" }]);
  expect(workspace.startWorktree).toHaveBeenCalledWith(request, expect.any(Function));
  await invoke("workspace:start", [{ ...request, run: "claude" }]);
  for (const bad of [
    null,
    [],
    { ...request, repository: "" },
    { ...request, branch: "" },
    { ...request, run: "sh" },
    { ...request, acknowledgeCodexNotifierReplacement: 1 },
  ])
    expect(() => invoke("workspace:start", [bad])).toThrow("Invalid worktree launch");
});

test("dirty removal uses main's trusted dialog and rejects renderer force flags", async () => {
  expect(() => invoke("workspace:remove", [null])).toThrow("Invalid terminal ID");
  expect(() => invoke("workspace:remove", ["foreign"])).toThrow("Unknown or foreign");
  requestDialog.mockResolvedValueOnce(false);
  await expect(invoke("workspace:remove", ["t1", true])).resolves.toBe(false);
  expect(requestDialog).toHaveBeenCalledWith({
    title: "Remove feature?",
    changes: "?? notes.txt\0",
    accept: "Discard 1 change and remove",
  });
  requestDialog.mockResolvedValueOnce(true);
  await expect(invoke("workspace:remove", ["t1"])).resolves.toBe(true);
});

test("sidebar commands copy known fields, validate IDs and paths, and keep confirmations in main", async () => {
  const inventory = vi.fn(() => Promise.resolve({ repositories: [], shell: "zsh" }));
  const command = vi.fn(async (_value: unknown, confirm: ConfirmWorkspace) => {
    expect(await confirm({ kind: "dirty-worktree", title: "Confirm", changes: "?? file\0" })).toBe(
      true,
    );
  });
  Object.assign(workspace, { sidebarInventory: inventory, sidebarCommand: command });
  requestDialog.mockResolvedValue(true);
  await invoke("workspace:sidebar");
  expect(inventory).toHaveBeenCalledOnce();
  for (const value of [
    { kind: "launch", repository: "/repo", worktree: "/tree", run: "shell" },
    { kind: "launch", repository: "/repo", worktree: "/tree", run: "claude" },
    { kind: "remove-repository", repository: "/repo" },
    { kind: "remove-worktree", repository: "/repo", worktree: "/tree" },
    { kind: "stop", id: "t1" },
    { kind: "close", id: "t1" },
    { kind: "restart", id: "t1" },
    { kind: "resume", id: "restored" },
    { kind: "new-conversation", id: "t1" },
    { kind: "copy-session-id", id: "restored" },
  ]) {
    await invoke("workspace:sidebar-command", [
      { ...value, executable: "/evil", sharedCheckout: true, conversationId: "forged" },
    ]);
    expect(command).toHaveBeenLastCalledWith(value, expect.any(Function));
  }
  for (const value of [
    null,
    [],
    { kind: "stop", id: "" },
    { kind: "close", id: "foreign" },
    { kind: "launch", repository: null },
    { kind: "launch", repository: "/repo", worktree: "" },
    { kind: "launch", repository: "/repo", worktree: "/tree", run: "evil" },
    { kind: "evil", repository: "/repo", worktree: "/tree" },
  ])
    expect(() => invoke("workspace:sidebar-command", [value])).toThrow();
});

test("dirty review counts a rename as one change while preserving both exact pathnames", async () => {
  requestDialog.mockResolvedValue(false);
  workspace.removeWorktree.mockImplementationOnce((_id, confirm) =>
    confirm("feature", "R  new name\0old name\0?? extra\0"),
  );
  await invoke("workspace:remove", ["t1"]);
  expect(requestDialog).toHaveBeenCalledWith({
    title: "Remove feature?",
    changes: "R  new name\0old name\0?? extra\0",
    accept: "Discard 2 changes and remove",
  });
});
test.each(["destroyed", "navigated"])(
  "dirty preparation cancels if the board is %s",
  async (state) => {
    workspace.removeWorktree.mockImplementationOnce((_id, confirm) => {
      if (state === "destroyed") contents.isDestroyed.mockReturnValue(true);
      else frame.url = "app://foreign/index.html";
      return confirm("feature", "?? file\0");
    });
    await expect(invoke("workspace:remove", ["t1"])).resolves.toBe(false);
    expect(contents.send).not.toHaveBeenCalled();
    expect(requestDialog).not.toHaveBeenCalled();
  },
);
test.each([
  ["remove", "Click again to remove"],
  ["stop", "Click again to stop"],
  ["shared-agent", "Click again for two agents here"],
  ["notifier", "Click again to replace notifier"],
] as const)("typed %s requests select their exact consequence", async (kind, label) => {
  Object.assign(workspace, {
    sidebarCommand: (_command: unknown, confirm: ConfirmWorkspace) => confirm({ kind }),
  });
  const pending = invoke("workspace:sidebar-command", [{ kind: "stop", id: "t1" }]);
  expect(contents.send).toHaveBeenCalledWith(
    "confirmation:armed",
    expect.objectContaining({ label }),
    undefined,
  );
  invoke("confirmation:cancel");
  await expect(pending).resolves.toBe(false);
});
