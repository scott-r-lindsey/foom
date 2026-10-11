import { beforeEach, expect, it, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import type { WorkspaceDependencies } from "../../../../src/main/workspace/workspace";
import { Operations } from "../../../../src/main/control/operations";
import type { Operation, Principal } from "../../../../src/main/control/types";
import type { AgentLaunch, AgentScan } from "../../../../src/shared/agents";
import type { WorkspaceConfirmation } from "../../../../src/shared/confirmation";
import type { VerdictRecord } from "../../../../src/shared/evaluator";

const repo = { path: "/repos/app", name: "app" };
const main = {
  path: repo.path,
  head: "abc",
  bare: false,
  branch: "main",
  locked: false,
  prunable: false,
  managed: false,
};
const child = { ...main, path: "/trees/app/feature", branch: "feature", managed: true };
const scan = (mcp: boolean): AgentScan => ({
  path: "/login/bin",
  warning: null,
  agents: [
    { id: "claude", path: "/bin/claude", version: "2.1.293", hooks: false, mcp, reason: "ok" },
  ],
});

let deps: WorkspaceDependencies;
let launch: ReturnType<
  typeof vi.fn<(request: AgentLaunch) => Promise<{ id: string; attention: "evaluator" }>>
>;
let scanned: AgentScan;
let stop: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
let tail: ReturnType<typeof vi.fn<(id: string, lines: number) => Promise<string[]>>>;
let confirm: ReturnType<typeof vi.fn<(request: WorkspaceConfirmation) => Promise<boolean>>>;

beforeEach(() => {
  scanned = scan(true);
  launch = vi.fn((_request: AgentLaunch) =>
    Promise.resolve({ id: "parent", attention: "evaluator" as const }),
  );
  stop = vi.fn(async (_id: string) => {});
  tail = vi.fn((_id: string, _lines: number) => Promise.resolve(["done"]));
  confirm = vi.fn((_request: WorkspaceConfirmation) => Promise.resolve(true));
  deps = {
    acknowledgeCodex: vi.fn(async () => {}),
    worktrees: {
      branches: vi.fn(),
      panelFacts: vi.fn(),
      listRepositories: vi.fn(() => [repo]),
      addRepository: vi.fn(() => Promise.resolve(repo)),
      listWorktrees: vi.fn(() => Promise.resolve([main, child])),
      validateBranch: vi.fn(async () => {}),
      launchIdentity: vi.fn(() => Promise.resolve("identity")),
      removalIdentity: vi.fn(() => Promise.resolve("identity")),
      changes: vi.fn(() => Promise.resolve("")),
      mergedDefault: vi.fn(() => Promise.resolve("base")),
      mergedCommit: vi.fn(() => Promise.resolve(false)),
      deleteMergedBranch: vi.fn(async () => {}),
      removeRepository: vi.fn(async () => {}),
      removeWorktree: vi.fn(async () => {}),
      createWorktree: vi.fn(() => Promise.resolve({ path: child.path, outcome: "new" as const })),
    },
    terminals: {
      stop,
      kill: vi.fn(async () => {}),
      create: vi.fn(() => Promise.resolve("shell")),
      tail,
    },
    verdicts: {
      forget: vi.fn(),
      classify: vi.fn(() => Promise.reject<VerdictRecord>(new Error("no evaluator"))),
      commit: vi.fn(async () => {}),
      recordAction: vi.fn(async () => {}),
    },
    receiver: vi.fn(() => Promise.reject(new Error("no hooks"))),
    onState: vi.fn(),
    onChange: vi.fn(),
    reveal: vi.fn(),
    dialog: vi.fn(() => Promise.resolve(true)),
    agents: () => ({
      scan: vi.fn(() => Promise.resolve(scanned)),
      launch,
      release: vi.fn(),
      dispose: vi.fn(),
      setHooksEnabled: vi.fn(),
    }),
    now: () => 1000,
  };
});

const orchestrate = (workspace: Workspace) =>
  workspace.sidebarCommand({ kind: "orchestrate", repository: repo.path, run: "claude" }, confirm);

function principal(): Principal {
  return Object.freeze({
    generation: "generation",
    sessionId: "session",
    repository: repo.path,
    worktree: repo.path,
    terminalId: "parent",
    parentId: null,
    role: "orchestrator" as const,
  });
}

it("launches an orchestrator in the main checkout after the trusted disclosure, once per repository", async () => {
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  expect(confirm).toHaveBeenCalledWith({ kind: "orchestrator", agent: "claude" });
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({
      worktree: repo.path,
      mainCheckout: true,
      control: { role: "orchestrator" },
    }),
  );
  expect(workspace.snapshot().terminals[0]?.orchestration).toEqual({
    role: "orchestrator",
    active: true,
    children: 0,
    history: [],
  });
  await orchestrate(workspace);
  expect(deps.reveal).toHaveBeenCalledWith("parent");
  expect(launch).toHaveBeenCalledTimes(1);
  void workspace.exited("parent", 0);
  expect(workspace.snapshot().terminals[0]?.orchestration).toMatchObject({ active: false });
});

it("refuses unavailable agents and releases the slot after refusal, decline or failure", async () => {
  let workspace = new Workspace(deps);
  scanned = { ...scan(false), agents: [] };
  await expect(orchestrate(workspace)).rejects.toThrow("installed agent");
  // Discovery is cached until a rescan, so a fresh workspace sees the upgraded agent.
  scanned = scan(true);
  await expect(orchestrate(workspace)).rejects.toThrow("installed agent");
  workspace = new Workspace(deps);
  confirm.mockResolvedValueOnce(false);
  await orchestrate(workspace);
  launch.mockRejectedValueOnce(new Error("spawn failed"));
  await expect(orchestrate(workspace)).rejects.toThrow("spawn failed");
  expect(launch).toHaveBeenCalledTimes(1);
  await orchestrate(workspace);
  expect(launch).toHaveBeenCalledTimes(2);
  expect(deps.reveal).not.toHaveBeenCalled();
});

it("creates fresh branches and launches children without bypass defaults or confirmation", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({
    hooks: false,
    agents: { claude: true, codex: true, agy: true },
    agentArguments: { claude: ["--dangerously-skip-permissions"], codex: [], agy: [] },
  });
  await orchestrate(workspace);
  expect(launch.mock.calls[0]?.[0].defaultArguments).toEqual(["--dangerously-skip-permissions"]);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const actor = principal();
  const tree = (await workspace.orchestration.call(
    actor,
    "create_worktree",
    { idempotencyKey: "a", branch: "feature" },
    operations,
  )) as Operation;
  expect(deps.worktrees.createWorktree).toHaveBeenCalledWith(repo.path, "feature", {
    location: "root",
    newBranch: true,
  });
  launch.mockResolvedValueOnce({ id: "child", attention: "evaluator" });
  confirm.mockClear();
  const started = (await workspace.orchestration.call(
    actor,
    "launch",
    { idempotencyKey: "b", worktreeId: tree.resultId, agent: "claude", prompt: "Write tests" },
    operations,
  )) as Operation;
  expect(started).toMatchObject({ status: "succeeded", resultId: "child" });
  expect(confirm).not.toHaveBeenCalled();
  expect(launch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      worktree: child.path,
      defaultArguments: [],
      sharedCheckout: false,
      mainCheckout: false,
      control: { parentId: "parent" },
      prompt: "Write tests",
    }),
  );
  const row = workspace.snapshot().terminals.find((entry) => entry.id === "child");
  expect(row).toMatchObject({
    launchFlags: [],
    bypass: false,
    orchestration: { role: "child", parentId: "parent", takenOver: false },
  });
  await workspace.orchestration.call(actor, "tail", { id: "child" }, operations);
  expect(tail).toHaveBeenCalledWith("child", 80);
  await workspace.orchestration.call(
    actor,
    "stop",
    { idempotencyKey: "c", id: "child" },
    operations,
  );
  expect(stop).toHaveBeenCalledWith("child");
  await workspace.sidebarCommand({ kind: "take-over", id: "child" }, confirm);
  expect(
    workspace.snapshot().terminals.find((entry) => entry.id === "child")?.orchestration,
  ).toMatchObject({
    takenOver: true,
  });
  await expect(
    workspace.sidebarCommand({ kind: "take-over", id: "parent" }, confirm),
  ).rejects.toThrow("no orchestrator");
  workspace.removed("child");
  expect(workspace.snapshot().terminals.some((entry) => entry.id === "child")).toBe(false);
});

it("removes an orchestrator worktree only through the trusted dialog", async () => {
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const actor = principal();
  const tree = (await workspace.orchestration.call(
    actor,
    "create_worktree",
    { idempotencyKey: "a", branch: "feature" },
    operations,
  )) as Operation;
  await workspace.orchestration.call(
    actor,
    "remove_worktree",
    { idempotencyKey: "r", worktreeId: tree.resultId },
    operations,
  );
  await vi.waitFor(() => {
    expect(deps.worktrees.removeWorktree).toHaveBeenCalledWith(
      repo.path,
      child.path,
      false,
      "identity",
    );
  });
  expect(deps.dialog).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Remove feature?" }),
    expect.any(AbortSignal),
  );

  // Without a trusted dialog, removal is declined rather than assumed.
  delete deps.dialog;
  const fallback = new Workspace(deps);
  await orchestrate(fallback);
  const fresh = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const other = (await fallback.orchestration.call(
    actor,
    "create_worktree",
    { idempotencyKey: "a", branch: "feature" },
    fresh,
  )) as Operation;
  await fallback.orchestration.call(
    actor,
    "remove_worktree",
    { idempotencyKey: "r2", worktreeId: other.resultId },
    fresh,
  );
  await vi.waitFor(() => {
    const view = fallback.orchestration.view("parent");
    expect(view?.role === "orchestrator" && view.history.map((entry) => entry.status)).toContain(
      "declined",
    );
  });
  expect(deps.worktrees.removeWorktree).toHaveBeenCalledTimes(1);
});

it("refuses to launch a child into the main checkout or an unavailable worktree", async () => {
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const actor = principal();
  vi.mocked(deps.worktrees.createWorktree).mockResolvedValueOnce({
    path: repo.path,
    outcome: "open",
  });
  const tree = (await workspace.orchestration.call(
    actor,
    "create_worktree",
    { idempotencyKey: "a", branch: "feature" },
    operations,
  )) as Operation;
  expect(
    await workspace.orchestration.call(
      actor,
      "launch",
      { idempotencyKey: "b", worktreeId: tree.resultId, agent: "claude" },
      operations,
    ),
  ).toMatchObject({ status: "failed" });
  expect(launch).toHaveBeenCalledTimes(1);
});

it("binds child worktrees to the identity captured at creation", async () => {
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const actor = principal();
  const tree = (await workspace.orchestration.call(
    actor,
    "create_worktree",
    { idempotencyKey: "a", branch: "feature" },
    operations,
  )) as Operation;
  // The human replaced the checkout at the same path.
  vi.mocked(deps.worktrees.launchIdentity).mockResolvedValue("replacement");
  expect(
    await workspace.orchestration.call(
      actor,
      "launch",
      { idempotencyKey: "b", worktreeId: tree.resultId, agent: "claude" },
      operations,
    ),
  ).toMatchObject({ status: "failed" });
  await workspace.orchestration.call(
    actor,
    "remove_worktree",
    { idempotencyKey: "r", worktreeId: tree.resultId },
    operations,
  );
  await vi.waitFor(() => {
    expect(operations.lookup(actor, { idempotencyKey: "r" })).toMatchObject({
      status: "failed",
    });
  });
  expect(deps.dialog).not.toHaveBeenCalled();
  expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
});

it("rechecks running sessions under the removal lock", async () => {
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const actor = principal();
  const tree = (await workspace.orchestration.call(
    actor,
    "create_worktree",
    { idempotencyKey: "a", branch: "feature" },
    operations,
  )) as Operation;
  // A human shell starts in the worktree after the orchestration-level check.
  vi.mocked(deps.worktrees.listWorktrees).mockImplementationOnce(async () => {
    await workspace.sidebarCommand(
      { kind: "launch", repository: repo.path, worktree: child.path, run: "shell" },
      confirm,
    );
    return [main, child];
  });
  await workspace.orchestration.call(
    actor,
    "remove_worktree",
    { idempotencyKey: "r", worktreeId: tree.resultId },
    operations,
  );
  await vi.waitFor(() => {
    expect(operations.lookup(actor, { idempotencyKey: "r" })).toMatchObject({
      status: "failed",
    });
  });
  expect(deps.dialog).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
});

it("reports a creation error as indeterminate when git may have added the checkout", async () => {
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const actor = principal();
  vi.mocked(deps.worktrees.createWorktree).mockRejectedValueOnce(new Error("save failed"));
  expect(
    await workspace.orchestration.call(
      actor,
      "create_worktree",
      { idempotencyKey: "a", branch: "feature" },
      operations,
    ),
  ).toMatchObject({ status: "indeterminate" });
  vi.mocked(deps.worktrees.createWorktree).mockRejectedValueOnce(new Error("invalid"));
  expect(
    await workspace.orchestration.call(
      actor,
      "create_worktree",
      { idempotencyKey: "b", branch: "other" },
      operations,
    ),
  ).toMatchObject({ status: "failed" });
  vi.mocked(deps.worktrees.createWorktree).mockRejectedValueOnce(new Error("invalid"));
  vi.mocked(deps.worktrees.listWorktrees).mockRejectedValueOnce(new Error("git failed"));
  expect(
    await workspace.orchestration.call(
      actor,
      "create_worktree",
      { idempotencyKey: "c", branch: "third" },
      operations,
    ),
  ).toMatchObject({ status: "indeterminate" });
});

it("a human relaunch of a child's session ends the orchestrator's ownership", async () => {
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const actor = principal();
  const tree = (await workspace.orchestration.call(
    actor,
    "create_worktree",
    { idempotencyKey: "a", branch: "feature" },
    operations,
  )) as Operation;
  launch.mockResolvedValueOnce({ id: "child", attention: "evaluator" });
  await workspace.orchestration.call(
    actor,
    "launch",
    { idempotencyKey: "b", worktreeId: tree.resultId, agent: "claude" },
    operations,
  );
  await workspace.exited("child", 0);
  launch.mockResolvedValueOnce({ id: "child", attention: "evaluator" });
  await workspace.sidebarCommand({ kind: "new-conversation", id: "child" }, confirm);
  expect(
    workspace.snapshot().terminals.find((entry) => entry.id === "child")?.orchestration,
  ).toBeUndefined();
});

it("permits CLI-only orchestrators and requires Antigravity interactive prompts", async () => {
  scanned = scan(false);
  await orchestrate(new Workspace(deps));
  scanned = {
    ...scan(false),
    agents: [
      {
        id: "agy",
        path: "/bin/agy",
        version: "1",
        hooks: false,
        mcp: false,
        cliGuidance: false,
        reason: "ok",
      },
    ],
  };
  await expect(
    new Workspace(deps).sidebarCommand(
      { kind: "orchestrate", repository: repo.path, run: "agy" },
      confirm,
    ),
  ).rejects.toThrow("initial prompt");
  scanned = {
    ...scanned,
    agents: scanned.agents.map((agent) => ({ ...agent, cliGuidance: true })),
  };
  await new Workspace(deps).sidebarCommand(
    { kind: "orchestrate", repository: repo.path, run: "agy" },
    confirm,
  );
  expect(launch).toHaveBeenLastCalledWith(
    expect.objectContaining({ agent: "agy", control: { role: "orchestrator" } }),
  );
});

it("restores running parents and owned children with new launches and retains history", async () => {
  const { readSessions } = await import("../../../../src/main/workspace/session-store");
  const entries = readSessions([
    {
      id: "parent",
      agent: "claude",
      repository: repo.path,
      worktree: repo.path,
      branch: "main",
      conversationId: "parent-conversation",
      running: true,
      orchestrator: {
        identity: "identity",
        history: [{ id: "old", action: "launch", label: "child", status: "succeeded", at: 1 }],
      },
    },
    {
      id: "child",
      agent: "claude",
      repository: repo.path,
      worktree: child.path,
      branch: "feature",
      conversationId: "child-conversation",
      running: true,
      parentId: "parent",
    },
    {
      id: "taken",
      agent: "claude",
      repository: repo.path,
      worktree: child.path,
      branch: "feature",
      conversationId: "taken-conversation",
      running: true,
    },
    {
      id: "exited",
      agent: "claude",
      repository: repo.path,
      worktree: child.path,
      branch: "feature",
      conversationId: "exited-conversation",
      running: false,
    },
  ]);
  const save = vi.fn(async () => {});
  deps.sessions = { load: () => Promise.resolve(entries), save, flush: async () => {} };
  launch.mockImplementation((request) =>
    Promise.resolve({
      id: request.terminalId ?? "new",
      attention: "evaluator",
    }),
  );
  const workspace = new Workspace(deps);
  workspace.configure({
    hooks: false,
    agents: { claude: true, codex: true, agy: true },
    agentArguments: { claude: ["--verbose"], codex: [], agy: [] },
  });
  await workspace.restore();
  expect(launch).not.toHaveBeenCalled();
  await workspace.restartSaved();
  expect(launch.mock.calls.map(([request]) => request.terminalId)).toEqual([
    "parent",
    "child",
    "taken",
  ]);
  expect(launch.mock.calls[0]?.[0]).toMatchObject({
    control: { role: "orchestrator" },
    conversationId: "parent-conversation",
    defaultArguments: ["--verbose"],
  });
  expect(launch.mock.calls[1]?.[0]).toMatchObject({
    control: { parentId: "parent" },
    conversationId: "child-conversation",
    defaultArguments: [],
    prompt: "Resume your previous task.",
  });
  expect(launch.mock.calls[2]?.[0].control).toBeUndefined();
  expect(confirm).not.toHaveBeenCalled();
  expect(workspace.snapshot().terminals[0]?.orchestration).toMatchObject({
    active: true,
    children: 1,
    history: [{ id: "old" }],
  });
  const operations = new Operations(
    async () => {},
    () => 1000,
  );
  const actor = { ...principal(), generation: "fresh-generation" };
  await workspace.orchestration.call(
    actor,
    "stop",
    { id: "child", idempotencyKey: "restored-stop" },
    operations,
  );
  expect(stop).toHaveBeenCalledWith("child");
  await expect(
    workspace.orchestration.call(actor, "tail", { id: "taken" }, operations),
  ).rejects.toThrow();
  await workspace.prepareQuit();
  const before = save.mock.calls.length;
  await workspace.exited("parent", 0);
  expect(save).toHaveBeenCalledTimes(before);
  await workspace.dispose();
});

it.each(["disabled", "unverified", "identity", "failed"])(
  "restoration handles %s without inheriting authority",
  async (mode) => {
    const { readSessions } = await import("../../../../src/main/workspace/session-store");
    const entries = readSessions([
      {
        id: "parent",
        agent: "claude",
        repository: repo.path,
        worktree: repo.path,
        branch: "main",
        conversationId: "saved",
        running: true,
        orchestrator: { identity: mode === "identity" ? "old" : "identity", history: [] },
      },
    ]);
    deps.sessions = {
      load: () => Promise.resolve(entries),
      save: async () => {},
      flush: async () => {},
    };
    if (mode === "unverified") scanned = scan(false);
    if (mode === "failed") launch.mockRejectedValue(new Error("spawn failed"));
    const workspace = new Workspace(deps);
    workspace.configure({
      hooks: false,
      agents: { claude: true, codex: true, agy: true },
      restoreSessions: mode !== "disabled",
    });
    await workspace.restore();
    await workspace.restartSaved();
    await workspace.restartSaved();
    expect(launch).toHaveBeenCalledTimes(mode === "disabled" ? 0 : 1);
    if (mode === "disabled" || mode === "failed")
      expect(workspace.snapshot().terminals[0]).toMatchObject({
        exited: true,
        conversationId: "saved",
      });
    else {
      expect(launch.mock.calls[0]?.[0].control).toBeUndefined();
      expect(workspace.snapshot().terminals[0]).toMatchObject({ roleNotRestored: true });
    }
    await workspace.dispose();
  },
);

it.each(["shell", "home", "config", "missing", "missing-repository", "no-conversation"])(
  "restores the %s case without inventing a conversation or location",
  async (mode) => {
    const { homedir } = await import("node:os");
    const { readSessions } = await import("../../../../src/main/workspace/session-store");
    const home = homedir();
    const location = mode === "home" ? home : mode === "config" ? "/config" : repo.path;
    deps.config = { root: "/config", cliDirectory: "/cli", check: () => Promise.resolve() };
    const record = {
      id: "restored",
      agent: mode === "no-conversation" ? "claude" : "shell",
      repository: location,
      worktree: location,
      branch: mode === "home" || mode === "config" ? null : "main",
      running: true,
      ...(mode === "home" ? { home: true } : {}),
      ...(mode === "config" ? { config: true } : {}),
    };
    if (mode === "missing") record.worktree = "/gone";
    if (mode === "missing-repository") record.repository = "/unregistered";
    const saved = readSessions([record]);
    const save = vi.fn<NonNullable<WorkspaceDependencies["sessions"]>["save"]>(() =>
      Promise.resolve(),
    );
    deps.sessions = { load: () => Promise.resolve(saved), save, flush: () => Promise.resolve() };
    const create = vi.fn<WorkspaceDependencies["terminals"]["create"]>((spec) =>
      Promise.resolve(spec.id ?? "new"),
    );
    deps.terminals.create = create;
    const workspace = new Workspace(deps);
    await workspace.restore();
    await workspace.restartSaved();
    const succeeds = ["shell", "home", "config"].includes(mode);
    expect(workspace.snapshot().terminals).toMatchObject([{ id: "restored", exited: !succeeds }]);
    expect(create).toHaveBeenCalledTimes(succeeds ? 1 : 0);
    expect(launch).not.toHaveBeenCalled();
    if (succeeds) {
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ id: "restored", cwd: location }),
      );
      await workspace.exited("restored", 0);
      expect(save.mock.calls.at(-1)?.[0][0]?.running).toBe(false);
      workspace.cancelQuit();
    }
    await workspace.dispose();
  },
);
