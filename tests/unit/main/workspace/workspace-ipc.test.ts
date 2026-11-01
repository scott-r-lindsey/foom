import type { ConfirmWorkspace, DialogContent } from "../../../../src/shared/confirmation";
import { beforeEach, expect, test, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { Workspace } from "../../../../src/main/workspace/workspace";

const mock = vi.hoisted(() => ({
  handle:
    vi.fn<(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void>(),
  removeHandler: vi.fn(),
  openExternal: vi.fn<() => Promise<void>>(),
  showMessageBox: vi.fn<() => Promise<{ response: number }>>(),
  showOpenDialog: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(),
}));
vi.mock("electron", () => ({
  shell: { openExternal: mock.openExternal },
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
const handoffEntries = vi.fn(() => [{ seq: 1, links: ["https://example.com/pr/1"] }]);
const workspace = {
  orchestration: { handoffs: { entries: handoffEntries } },
  messageBoard: vi.fn(),
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
    "workspace:message-board",
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
      expect(() => invoke(channel, [], event)).toThrow("foom-error:operation-failed");
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
    expect(() => invoke("workspace:worktrees", [bad])).toThrow("foom-error:operation-failed");

  await invoke("workspace:branches", ["/repos/app"]);
  expect(workspace.branches).toHaveBeenCalledWith("/repos/app");
  for (const args of [[], [undefined], [""], ["/repos/app", "extra"], ["a\0b"]])
    expect(() => invoke("workspace:branches", args)).toThrow("foom-error:operation-failed");

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
    expect(() => invoke("workspace:create-worktree", args)).toThrow("foom-error:operation-failed");

  await invoke("agents:scan", [true]);
  expect(workspace.scanAgents).toHaveBeenCalledWith(true);
  expect(() => invoke("agents:scan", ["yes"])).toThrow("foom-error:operation-failed");
});

test("launch requests are validated and copied field by field", async () => {
  const request = {
    agent: "codex",
    repository: "/repos/app",
    worktree: "/trees/app/x",
    cols: 80,
    rows: 24,
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
    },
    expect.any(Function),
  );
  const plain: Record<string, unknown> = { ...request };
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
  ])
    expect(() => invoke("agents:launch", [bad])).toThrow("foom-error:operation-failed");
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
    await expect(invoke("terminal:feedback", args)).rejects.toThrow("foom-error:operation-failed");
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
  ])
    expect(() => invoke("workspace:start", [bad])).toThrow("foom-error:operation-failed");
});

test("dirty removal uses main's trusted dialog and rejects renderer force flags", async () => {
  expect(() => invoke("workspace:remove", [null])).toThrow("foom-error:operation-failed");
  expect(() => invoke("workspace:remove", ["foreign"])).toThrow("foom-error:operation-failed");
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
    { kind: "make-orchestrator", id: "t1" },
    { kind: "revoke-orchestrator", id: "t1" },
  ]) {
    await invoke("workspace:sidebar-command", [
      value.kind.startsWith("copy-")
        ? value
        : { ...value, executable: "/evil", sharedCheckout: true, conversationId: "forged" },
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
  expect(JSON.stringify(disclosure.sections)).toContain(
    "Post local Board threads for this repository.",
  );
  expect(JSON.stringify(disclosure.sections)).toContain(
    "Board posts addressed to or opened by this repository.",
  );
  expect(JSON.stringify(disclosure.sections)).toMatch(
    /Board posts may be sent to this agent's model provider/u,
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
    expect(() => invoke("agents:agy-plugin", args)).toThrow("foom-error:operation-failed");
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
    expect(() => invoke("workspace:panel-facts", args)).toThrow("foom-error:operation-failed");
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

test("menu config launches dispatch without a notifier dialog", async () => {
  const command = vi.fn(async () => {});
  Object.assign(workspace, { sidebarCommand: command });
  await invoke("workspace:sidebar-command", [{ kind: "config-launch", run: "codex" }]);
  expect(command).toHaveBeenCalledOnce();
  expect(requestDialog).not.toHaveBeenCalled();
});

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
    {
      id: "d".repeat(32),
      worktree: "foom:manual",
      relativePath: "manual.html",
      network: false,
      bundled: "manual",
    },
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
      {
        id: "d".repeat(32),
        repository: "",
        worktree: "foom:manual",
        relativePath: "manual.html",
        network: false,
        kind: "html",
      },
    ],
  });
});

test("unavailable membership preserves open preview IDs but not closed or confirmed removed previews", async () => {
  const preview = {
    id: "a".repeat(32),
    worktree: "/tree",
    relativePath: "saved.md",
    network: false,
  };
  let records = [preview];
  const inventory = vi.fn<Workspace["sidebarInventory"]>();
  Object.assign(workspace, { sidebarInventory: inventory });
  mock.handle.mockClear();
  attachWorkspace(
    window,
    workspace as unknown as Workspace,
    owns,
    requestDialog,
    undefined,
    () => records,
  );
  inventory.mockResolvedValue({
    shell: "bash",
    repositories: [
      {
        path: "/repo",
        name: "repo",
        worktrees: [
          {
            path: "/tree",
            head: "abc",
            branch: "main",
            bare: false,
            locked: false,
            prunable: false,
            managed: false,
          },
        ],
      },
    ],
  });
  const expected = { ...preview, repository: "/repo", kind: "markdown" };
  await expect(invoke("workspace:sidebar")).resolves.toMatchObject({ previews: [expected] });
  inventory.mockResolvedValue({
    shell: "bash",
    repositories: [{ path: "/repo", name: "repo", unavailable: true, worktrees: [] }],
  });
  await expect(invoke("workspace:sidebar")).resolves.toMatchObject({ previews: [expected] });
  inventory.mockResolvedValue({
    shell: "bash",
    repositories: [
      { path: "/repo", name: "repo", worktrees: [] },
      { path: "/other", name: "other", unavailable: true, worktrees: [] },
    ],
  });
  await expect(invoke("workspace:sidebar")).resolves.toMatchObject({ previews: [] });
  inventory.mockResolvedValue({
    shell: "bash",
    repositories: [{ path: "/repo", name: "repo", unavailable: true, worktrees: [] }],
  });
  await expect(invoke("workspace:sidebar")).resolves.toMatchObject({ previews: [expected] });
  records = [];
  await expect(invoke("workspace:sidebar")).resolves.toMatchObject({ previews: [] });
  records = [preview];
  inventory.mockResolvedValue({
    shell: "bash",
    repositories: [{ path: "/repo", name: "repo", worktrees: [] }],
  });
  await expect(invoke("workspace:sidebar")).resolves.toMatchObject({ previews: [] });
});

test("a first partial inventory cannot claim an owned preview is removed", async () => {
  const inventory = vi.fn<Workspace["sidebarInventory"]>().mockResolvedValue({
    shell: "bash",
    repositories: [{ path: "/repo", name: "repo", unavailable: true, worktrees: [] }],
  });
  Object.assign(workspace, { sidebarInventory: inventory });
  mock.handle.mockClear();
  attachWorkspace(window, workspace as unknown as Workspace, owns, requestDialog, undefined, () => [
    {
      id: "b".repeat(32),
      worktree: "/linked-outside-repo",
      relativePath: "saved.md",
      network: false,
    },
  ]);
  await expect(invoke("workspace:sidebar")).resolves.toMatchObject({
    previews: [{ id: "b".repeat(32), repository: "", worktree: "/linked-outside-repo" }],
  });
  inventory.mockResolvedValue({ shell: "bash", repositories: [] });
  await expect(invoke("workspace:sidebar")).resolves.toMatchObject({ previews: [] });
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
    expect(() => invoke("agents:setup", args)).toThrow("foom-error:operation-failed");
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

test("handoff links resolve from owned records and require trusted confirmation", async () => {
  const command = { kind: "open-handoff-link", id: "restored", seq: 1, index: 0 };
  requestDialog.mockResolvedValueOnce(true);
  await invoke("workspace:sidebar-command", [command]);
  expect(requestDialog).toHaveBeenCalledWith(
    expect.objectContaining({ subject: "https://example.com/pr/1" }),
  );
  expect(mock.openExternal).toHaveBeenCalledWith("https://example.com/pr/1");
  mock.openExternal.mockClear();
  requestDialog.mockResolvedValueOnce(false);
  await invoke("workspace:sidebar-command", [command]);
  expect(mock.openExternal).not.toHaveBeenCalled();
  for (const change of [
    { url: "https://evil.test" },
    { seq: 0 },
    { seq: 1.5 },
    { index: -1 },
    { index: 10 },
    { id: "foreign" },
  ])
    expect(() => invoke("workspace:sidebar-command", [{ ...command, ...change }])).toThrow();
  handoffEntries.mockReturnValueOnce([]);
  expect(() => invoke("workspace:sidebar-command", [command])).toThrow(
    "foom-error:operation-failed",
  );
  handoffEntries.mockReturnValueOnce([{ seq: 1, links: ["file:///tmp/private"] }]);
  expect(() => invoke("workspace:sidebar-command", [command])).toThrow(
    "foom-error:operation-failed",
  );
  requestDialog.mockImplementationOnce(() => {
    handoffEntries.mockReturnValueOnce([]);
    return Promise.resolve(true);
  });
  await invoke("workspace:sidebar-command", [command]);
  expect(mock.openExternal).not.toHaveBeenCalled();
});

test.each(["prune-worktree", "cleanup-worktree"])(
  "%s copies only repository and worktree and rejects extra authority fields",
  async (kind) => {
    const command = { kind, repository: "/repo", worktree: "/tree" };
    const sidebar = vi.fn(() => Promise.resolve());
    attached.dispose();
    mock.handle.mockClear();
    attached = attachWorkspace(
      window,
      { ...workspace, sidebarCommand: sidebar } as unknown as Workspace,
      owns,
      requestDialog,
    );
    await invoke("workspace:sidebar-command", [command]);
    expect(sidebar).toHaveBeenCalledWith(command, expect.any(Function));
    for (const invalid of [
      { ...command, force: true },
      { kind, repository: "/repo", unexpected: "/tree" },
      { ...command, worktree: "" },
      { ...command, repository: null },
    ]) {
      expect(() => invoke("workspace:sidebar-command", [invalid])).toThrow(
        "foom-error:operation-failed",
      );
    }
  },
);

test("workspace rejections contain only a selected code, never raw exception details", async () => {
  const { ApplicationError } = await import("../../../../src/shared/application-errors");
  workspace.createWorktree.mockRejectedValueOnce(new ApplicationError("worktree-prunable"));
  await expect(invoke("workspace:create-worktree", ["/repo", "branch"])).rejects.toThrow(
    "foom-error:worktree-prunable",
  );
  Object.assign(workspace, {
    sidebarCommand: vi.fn().mockRejectedValueOnce(new ApplicationError("session-has-children", 3)),
  });
  await expect(invoke("workspace:sidebar-command", [{ kind: "close", id: "t1" }])).rejects.toThrow(
    "foom-error:session-has-children:3",
  );
  workspace.createWorktree.mockRejectedValueOnce(new Error("private path and credentials"));
  await expect(invoke("workspace:create-worktree", ["/repo", "branch"])).rejects.toThrow(
    /^foom-error:operation-failed$/u,
  );
});

test("copy commands accept only identifiers and refuse malformed or foreign targets before dispatch", async () => {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  Object.assign(workspace, { sidebarCommand: dispatch });
  const commands = [
    ...[
      "copy-default-branch",
      "copy-worktree-branch",
      "copy-worktree-head",
      "copy-pull-request-number",
      "copy-pull-request-url",
      "copy-remote-url",
    ].map((kind) => ({ kind, repository: "/repo", worktree: "/tree" })),
    ...["copy-foom-session-id", "copy-parent-id"].map((kind) => ({ kind, id: "t1" })),
    { kind: "copy-child-id", id: "t1", child: "child" },
    { kind: "copy-handoff-summary", id: "t1", seq: 1 },
    { kind: "copy-error-text", error: "worktree-locked" },
  ];
  for (const command of commands) {
    await invoke("workspace:sidebar-command", [command]);
    expect(dispatch).toHaveBeenLastCalledWith(command, expect.any(Function));
    expect(() =>
      invoke("workspace:sidebar-command", [{ ...command, text: "arbitrary" }]),
    ).toThrow();
    expect(() =>
      invoke("workspace:sidebar-command", [command], {
        ...trusted,
        senderFrame: { url: frame.url },
      }),
    ).toThrow();
  }
  for (const value of [
    { kind: "copy-child-id", id: "t1", child: "" },
    { kind: "copy-handoff-summary", id: "t1", seq: 0 },
    { kind: "copy-handoff-summary", id: "t1", seq: 1.5 },
    { kind: "copy-parent-id", id: "foreign" },
    { kind: "copy-error-text", error: "__proto__" },
    { kind: "copy-error-text", error: "arbitrary text" },
  ])
    expect(() => invoke("workspace:sidebar-command", [value])).toThrow();
});

test("only a close's trusted remote launch failure selects its fixed diagnostic", async () => {
  const { LaunchFailure } = await import("../../../../src/shared/launch-failure");
  const command = vi.fn().mockRejectedValue(new LaunchFailure("remote_host_unreachable"));
  Object.assign(workspace, { sidebarCommand: command });
  await expect(invoke("workspace:sidebar-command", [{ kind: "close", id: "t1" }])).rejects.toThrow(
    "foom-error:session-remote-unreachable",
  );
  await expect(invoke("workspace:sidebar-command", [{ kind: "resume", id: "t1" }])).rejects.toThrow(
    "foom-error:operation-failed",
  );
  command.mockRejectedValueOnce(new LaunchFailure("launch_failed"));
  await expect(invoke("workspace:sidebar-command", [{ kind: "close", id: "t1" }])).rejects.toThrow(
    "foom-error:operation-failed",
  );
  command.mockRejectedValueOnce(new Error("remote_host_unreachable secret text"));
  await expect(invoke("workspace:sidebar-command", [{ kind: "close", id: "t1" }])).rejects.toThrow(
    "foom-error:operation-failed",
  );
});

test("board IPC is sender checked and accepts only method plus payload", () => {
  invoke("workspace:message-board", ["threads", {}]);
  expect(workspace.messageBoard).toHaveBeenCalledWith("threads", {});
  for (const args of [[], ["threads"], [3, {}], ["read", {}, "extra"]])
    expect(() => invoke("workspace:message-board", args)).toThrow();
});
