import type { ConfirmWorkspace, DialogContent } from "../../../../src/shared/confirmation";
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
import {
  attachWorkspace,
  orchestratorDisclosure,
} from "../../../../src/main/workspace/workspace-ipc";

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
  actionLog: vi.fn(),
  clearActionLog: vi.fn(),
  panelFacts: vi.fn(),
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
  branches: vi.fn(() =>
    Promise.resolve({ head: "main", local: [], remote: null, remoteBranches: [] }),
  ),
  changeAgentSetup: vi.fn(
    (_id: string, _action: string, _confirm: (content: DialogContent) => Promise<boolean>) =>
      Promise.resolve({ warning: null, agents: [] }),
  ),
  changeAgyPlugin: vi.fn((_action: string, _confirm: () => Promise<boolean>) =>
    Promise.resolve({ warning: null, agents: [] }),
  ),
  scanAgents: vi.fn(() => Promise.resolve({ warning: null, agents: [] })),
  launch: vi.fn((_request: unknown) => Promise.resolve({ id: "t1", attention: "evaluator" })),
  feedback: vi.fn(() => Promise.resolve()),
};
const requestDialog = vi.fn<(content: DialogContent) => Promise<boolean>>();
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
    "workspace:panel-facts",
    "workspace:sidebar",
    "workspace:sidebar-command",
    "workspace:action-log",
    "workspace:clear-action-log",
    "workspace:snapshot",
    "workspace:add-repository",
    "workspace:worktrees",
    "workspace:branches",
    "workspace:create-worktree",
    "agents:scan",
    "agents:setup",
    "agents:agy-plugin",
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

  await invoke("workspace:branches", ["/repos/app"]);
  expect(workspace.branches).toHaveBeenCalledWith("/repos/app");
  for (const args of [[], [undefined], [""], ["/repos/app", "extra"], ["a\0b"]])
    expect(() => invoke("workspace:branches", args)).toThrow("Invalid repository");

  await invoke("workspace:create-worktree", ["/repos/app", "feature/x", "adjacent"]);
  expect(workspace.createWorktree).toHaveBeenCalledWith("/repos/app", "feature/x", "adjacent");
  // The branch field leaves the location to main's configured choice.
  await invoke("workspace:create-worktree", ["/repos/app", "feature/y"]);
  expect(workspace.createWorktree).toHaveBeenLastCalledWith("/repos/app", "feature/y", undefined);
  for (const args of [
    ["/repos/app", "b", "root", "extra"],
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
    acknowledgeNotifierReplacement: true,
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
      acknowledgeNotifierReplacement: true,
    },
    expect.any(Function),
  );
  const plain: Record<string, unknown> = { ...request };
  delete plain["acknowledgeNotifierReplacement"];
  await invoke("agents:launch", [plain]);
  expect(workspace.launch.mock.lastCall?.[0]).not.toHaveProperty("acknowledgeNotifierReplacement");
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
    { ...plain, acknowledgeNotifierReplacement: "yes" },
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
    acknowledgeNotifierReplacement: false,
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
    { ...request, acknowledgeNotifierReplacement: 1 },
  ])
    expect(() => invoke("workspace:start", [bad])).toThrow("Invalid worktree launch");
});

test("dirty removal uses main's trusted dialog and rejects renderer force flags", async () => {
  expect(() => invoke("workspace:remove", [null])).toThrow("Invalid terminal ID");
  expect(() => invoke("workspace:remove", ["foreign"])).toThrow("Unknown or foreign");
  requestDialog.mockResolvedValueOnce(false);
  await expect(invoke("workspace:remove", ["t1", true])).resolves.toBe(false);
  expect(requestDialog).toHaveBeenCalledWith({
    title: "Remove worktree with uncommitted changes?",
    subject: "feature",
    glyph: "branch",
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
    { kind: "delete-merged-worktrees", repository: "/repo" },
    { kind: "remove-worktree", repository: "/repo", worktree: "/tree" },
    { kind: "copy-worktree-path", repository: "/repo", worktree: "/tree" },
    { kind: "stop", id: "t1" },
    { kind: "close", id: "t1" },
    { kind: "restart", id: "t1" },
    { kind: "resume", id: "restored" },
    { kind: "new-conversation", id: "t1" },
    { kind: "copy-session-id", id: "restored" },
    { kind: "take-over", id: "t1" },
    { kind: "reset-replies", id: "t1" },
    { kind: "make-orchestrator", id: "t1" },
    { kind: "revoke-orchestrator", id: "t1" },
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
    { kind: "review", repository: "/repo", worktree: "/tree", run: "claude" },
    { kind: "review", repository: "/repo", worktree: "/tree", run: "codex" },
    { kind: "review", repository: "/repo", worktree: "/tree", run: "agy" },
    { kind: "review", repository: "/repo", worktree: "/tree", run: "shell" },
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
    title: "Remove worktree with uncommitted changes?",
    subject: "feature",
    glyph: "branch",
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
  ["shared-agent", "Click again for multiple agents here"],
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

test.each(["trusted", "destroyed", "navigated"])(
  "merged cleanup uses the trusted dialog with a %s board",
  async (state) => {
    const worktrees = [{ branch: "merged" }, { branch: "kept", reason: "running" }];
    Object.assign(workspace, {
      sidebarCommand: (_command: unknown, confirm: ConfirmWorkspace) => {
        if (state === "destroyed") contents.isDestroyed.mockReturnValue(true);
        if (state === "navigated") frame.url = "app://foreign/index.html";
        return confirm({ kind: "merged-worktrees", worktrees });
      },
    });
    requestDialog.mockResolvedValue(true);
    await expect(
      invoke("workspace:sidebar-command", [
        { kind: "delete-merged-worktrees", repository: "/repo" },
      ]),
    ).resolves.toBe(state === "trusted");
    if (state === "trusted")
      expect(requestDialog).toHaveBeenCalledWith({
        title: "Delete merged worktrees?",
        accept: "Delete",
        worktrees,
      });
    else expect(requestDialog).not.toHaveBeenCalled();
  },
);

test.each(["trusted", "destroyed", "navigated"])(
  "making an orchestrator discloses through the trusted dialog with a %s board",
  async (state) => {
    Object.assign(workspace, {
      sidebarCommand: (_command: unknown, confirm: ConfirmWorkspace) => {
        if (state === "destroyed") contents.isDestroyed.mockReturnValue(true);
        if (state === "navigated") frame.url = "app://foreign/index.html";
        return confirm({ kind: "orchestrator", agent: "codex" });
      },
    });
    requestDialog.mockResolvedValue(true);
    await expect(
      invoke("workspace:sidebar-command", [{ kind: "make-orchestrator", id: "t1" }]),
    ).resolves.toBe(state === "trusted");
    if (state === "trusted")
      expect(requestDialog).toHaveBeenCalledWith(orchestratorDisclosure("codex"));
    else expect(requestDialog).not.toHaveBeenCalled();
  },
);

test("orchestrator commands name only an owned terminal; the disclosure names a transfer", () => {
  const command = vi.fn(async () => {});
  Object.assign(workspace, { sidebarCommand: command });
  for (const value of [
    { kind: "make-orchestrator", id: "foreign" },
    { kind: "revoke-orchestrator", id: "" },
    { kind: "orchestrate", repository: "/repo", run: "claude" },
  ])
    expect(() => invoke("workspace:sidebar-command", [value])).toThrow();
  expect(command).not.toHaveBeenCalled();
  const disclosure = orchestratorDisclosure("claude");
  expect(disclosure.title).toBe("Make Claude Code the Foom orchestrator?");
  expect(disclosure.accept).toBe("Make orchestrator");
  expect(JSON.stringify(disclosure.sections)).toContain(
    "Close its exited children, discarding their final screens; their worktrees and branches remain.",
  );
  expect(JSON.stringify(disclosure.sections)).toMatch(/model provider/u);
  expect(JSON.stringify(disclosure.sections)).toMatch(/redaction cannot catch every secret/u);
  expect(JSON.stringify(disclosure.sections)).not.toMatch(/stops orchestrating/u);
  expect(orchestratorDisclosure("agy").title).toContain("Antigravity");
  expect(orchestratorDisclosure("codex", "Claude Code on main").note).toMatch(
    /^Claude Code on main stops orchestrating; its children stay with you\./u,
  );
});

test("Antigravity plugin IPC accepts only one fixed operation, never paths or CLI arguments", async () => {
  for (const action of ["install", "update", "enable", "remove"]) {
    await invoke("agents:agy-plugin", [action]);
    expect(workspace.changeAgentSetup).toHaveBeenLastCalledWith(
      "agy",
      action,
      expect.any(Function),
    );
    expect(workspace.changeAgyPlugin).not.toHaveBeenCalled();
  }
  for (const args of [
    [],
    ["install", "/untrusted/plugin"],
    ["uninstall"],
    [{ action: "install" }],
    [null],
    ["install;touch bad"],
  ])
    expect(() => invoke("agents:agy-plugin", args)).toThrow("Invalid plugin request");
});

test("panel facts validate exact arguments before authorizing paths", async () => {
  for (const args of [
    [],
    ["/repo"],
    ["/repo", ""],
    ["/repo", "/tree", true],
    [null, "/tree"],
    ["/repo", "a\0b"],
  ])
    expect(() => invoke("workspace:panel-facts", args)).toThrow("Invalid panel request");
  await invoke("workspace:panel-facts", ["/repo", "/tree"]);
  expect(workspace.panelFacts).toHaveBeenCalledWith("/repo", "/tree");
  expect(() =>
    invoke("workspace:sidebar-command", [{ kind: "home-shell", cwd: "/arbitrary" }]),
  ).toThrow();
});

test("config sidebar commands accept only a run kind, never a path", async () => {
  const command = vi.fn(() => Promise.resolve());
  Object.assign(workspace, { sidebarCommand: command });
  for (const command of [
    { kind: "config-launch" },
    { kind: "config-launch", run: "bash" },
    { kind: "config-launch", run: "codex", origin: true },
    { kind: "config-launch", run: "codex", origin: "sidebar" },
    { kind: "config-launch", run: "claude", cwd: "/elsewhere" },
    { kind: "copy-config-path", path: "/etc" },
  ])
    expect(() => invoke("workspace:sidebar-command", [command])).toThrow();
  await invoke("workspace:sidebar-command", [{ kind: "config-launch", run: "shell" }]);
  await invoke("workspace:sidebar-command", [{ kind: "config-launch", run: "codex" }]);
  await invoke("workspace:sidebar-command", [{ kind: "copy-config-path" }]);
  expect(command.mock.calls.map((call: unknown[]) => call[0])).toEqual([
    { kind: "config-launch", run: "shell" },
    { kind: "config-launch", run: "codex" },
    { kind: "copy-config-path" },
  ]);
});

test.each([false, true])(
  "menu config launches retain notifier disclosure (accepted %s)",
  async (accepted) => {
    requestDialog.mockResolvedValue(accepted);
    const command = vi.fn(async (_value: unknown, confirm: ConfirmWorkspace) => {
      expect(await confirm({ kind: "notifier" })).toBe(accepted);
    });
    Object.assign(workspace, { sidebarCommand: command });
    await invoke("workspace:sidebar-command", [
      { kind: "config-launch", run: "codex", origin: "menu" },
    ]);
    expect(requestDialog).toHaveBeenCalledWith({
      title: "Replace Codex notifier for this launch?",
      glyph: "bell",
      subject: "This launch only",
      quiet: "Your global Codex configuration is unchanged.",
      detail: expect.stringContaining("for this invocation") as unknown,
      accept: "Replace notifier and launch",
    });
    expect(contents.send).not.toHaveBeenCalledWith("confirmation:armed", expect.anything());
  },
);

test.each(["destroyed", "navigated"])(
  "menu disclosure is refused after its board is %s",
  async (state) => {
    const command = vi.fn(async (_value: unknown, confirm: ConfirmWorkspace) => {
      if (state === "destroyed") contents.isDestroyed.mockReturnValue(true);
      else frame.url = "https://elsewhere.test";
      expect(await confirm({ kind: "notifier" })).toBe(false);
    });
    Object.assign(workspace, { sidebarCommand: command });
    await invoke("workspace:sidebar-command", [
      { kind: "config-launch", run: "codex", origin: "menu" },
    ]);
    expect(requestDialog).not.toHaveBeenCalled();
  },
);

test("resume-id validates the exact payload and does not confuse conversation IDs with terminal IDs", async () => {
  const command = vi.fn(async () => {});
  Object.assign(workspace, { sidebarCommand: command });
  const valid = {
    kind: "resume-id",
    checkout: { repository: "/repo", worktree: "/tree" },
    agent: "claude",
    id: "conversation-123",
  };
  await invoke("workspace:sidebar-command", [valid]);
  expect(command).toHaveBeenCalledWith(valid, expect.any(Function));
  command.mockClear();
  for (const payload of [
    { ...valid, id: "--last" },
    { ...valid, id: "a".repeat(201) },
    { ...valid, id: 4 },
    { ...valid, agent: "shell" },
    { ...valid, agent: "unknown" },
    { ...valid, checkout: null },
    { ...valid, checkout: [] },
    { ...valid, checkout: { repository: "/repo" } },
    { ...valid, checkout: { repository: "", worktree: "/tree" } },
    { ...valid, checkout: { repository: "/repo", worktree: "x\0y" } },
    { ...valid, checkout: { ...valid.checkout, identity: "forged" } },
    { ...valid, raw: "claude --resume conversation-123" },
  ])
    expect(() => invoke("workspace:sidebar-command", [payload])).toThrow();
  expect(() =>
    invoke("workspace:sidebar-command", [valid], {
      sender: contents,
      senderFrame: { url: frame.url },
    }),
  ).toThrow();
  expect(command).not.toHaveBeenCalled();
});

test("action log capabilities reject extra arguments and keep queries behind main", () => {
  const query = { search: "child", action: "reply", status: "indeterminate", offset: 0 };
  invoke("workspace:action-log", [query]);
  expect(workspace.actionLog).toHaveBeenCalledWith(query);
  invoke("workspace:clear-action-log");
  expect(workspace.clearActionLog).toHaveBeenCalledOnce();
  expect(() => invoke("workspace:action-log", [])).toThrow();
  expect(() => invoke("workspace:action-log", [query, "extra"])).toThrow();
  expect(() => invoke("workspace:clear-action-log", ["path"])).toThrow();
});

test("sidebar inventory reports previews only for worktrees it lists", async () => {
  mock.handle.mockClear();
  attachWorkspace(window, workspace as unknown as Workspace, owns, requestDialog, undefined, () => [
    {
      id: "a".repeat(32),
      worktree: "/tree",
      relativePath: "docs/Readme.MD",
      network: false,
      openedBy: { terminalId: "agent", agent: "claude" },
    },
    { id: "b".repeat(32), worktree: "/tree", relativePath: "site/index.html", network: false },
    { id: "c".repeat(32), worktree: "/gone", relativePath: "a.md", network: false },
  ]);
  Object.assign(workspace, {
    sidebarInventory: vi.fn(() =>
      Promise.resolve({
        repositories: [
          { path: "/other", worktrees: [{ path: "/other" }] },
          { path: "/repo", worktrees: [{ path: "/repo" }, { path: "/tree" }] },
        ],
        shell: "zsh",
      }),
    ),
  });
  await expect(invoke("workspace:sidebar")).resolves.toMatchObject({
    previews: [
      {
        id: "a".repeat(32),
        repository: "/repo",
        worktree: "/tree",
        relativePath: "docs/Readme.MD",
        openedBy: { terminalId: "agent", agent: "claude" },
        network: false,
        kind: "markdown",
      },
      {
        id: "b".repeat(32),
        repository: "/repo",
        worktree: "/tree",
        relativePath: "site/index.html",
        network: false,
        kind: "html",
      },
    ],
  });
});

test.each(["install", "update", "enable", "remove"])(
  "legacy plugin %s forwards model-owned disclosure and closes on navigation",
  async (action) => {
    requestDialog.mockResolvedValueOnce(false);
    await invoke("agents:agy-plugin", [action]);
    const confirm = workspace.changeAgentSetup.mock.calls.at(-1)?.[2];
    if (!confirm) throw new Error("Missing plugin confirmation");
    const content: DialogContent = {
      title: "Reviewed setup",
      accept: "Install",
      glyph: "shield",
      detail: "Model-owned exact staging and fixed argv",
    };
    expect(await confirm(content)).toBe(false);
    expect(requestDialog).toHaveBeenCalledWith(content);
    contents.isDestroyed.mockReturnValue(true);
    expect(await confirm(content)).toBe(false);
    contents.isDestroyed.mockReturnValue(false);
    frame.url = "https://untrusted.test";
    expect(await confirm(content)).toBe(false);
    expect(requestDialog).toHaveBeenCalledTimes(1);
  },
);

test("validates fixed setup action requests and uses the trusted dialog", async () => {
  for (const args of [
    [],
    ["claude"],
    ["unknown", "install"],
    ["claude", "bad/action"],
    ["claude", "install", true],
  ])
    expect(() => invoke("agents:setup", args)).toThrow("Invalid setup request");
  await invoke("agents:setup", ["claude", "install"]);
  const confirm = workspace.changeAgentSetup.mock.calls.at(-1)?.[2];
  if (!confirm) throw Error("Missing confirmation");
  const content = { title: "Install?", accept: "Install" };
  requestDialog.mockResolvedValueOnce(true);
  await expect(confirm(content)).resolves.toBe(true);
  expect(requestDialog).toHaveBeenLastCalledWith(content);
  contents.isDestroyed.mockReturnValue(true);
  await expect(confirm(content)).resolves.toBe(false);
  contents.isDestroyed.mockReturnValue(false);
  frame.url = "https://untrusted.invalid";
  await expect(confirm(content)).resolves.toBe(false);
});
