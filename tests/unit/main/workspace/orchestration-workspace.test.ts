import * as reviewSnapshots from "../../../../src/main/workspace/review-snapshot";
import { ForgeTracking } from "../../../../src/main/control/forge-tracking";
import type { ChildInput } from "../../../../src/shared/child-input";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import { beforeEach, expect, it, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import type { WorkspaceDependencies } from "../../../../src/main/workspace/workspace-types";
import { ControlStore } from "../../../../src/main/control/store";
import { Operations } from "../../../../src/main/control/operations";
import type { Operation, Principal } from "../../../../src/main/control/types";
import type { ControlRuntime } from "../../../../src/main/control/runtime";
import type { AgentLaunch, AgentScan } from "../../../../src/shared/agents";
import type { RemovalFeed, WorkspaceConfirmation } from "../../../../src/shared/confirmation";
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
let setRole: ReturnType<typeof vi.fn<ControlRuntime["setRole"]>>;

beforeEach(() => {
  agentProvider("codex").discover("/bin/codex", "codex-cli 0.161.0", "-c");
  scanned = scan(true);
  launch = vi.fn((_request: AgentLaunch) =>
    Promise.resolve({ id: "parent", attention: "evaluator" as const }),
  );
  stop = vi.fn(async (_id: string) => {});
  tail = vi.fn((_id: string, _lines: number) => Promise.resolve(["done"]));
  confirm = vi.fn((_request: WorkspaceConfirmation) => Promise.resolve(true));
  setRole = vi.fn<ControlRuntime["setRole"]>();
  deps = {
    control: () =>
      Promise.resolve({
        prepare: vi.fn<ControlRuntime["prepare"]>(),
        close: vi.fn(async () => {}),
        setRole,
      }),
    worktrees: {
      branches: vi.fn(),
      canAutoRemove: vi.fn(() => Promise.resolve(false)),
      panelFacts: vi.fn(),
      listRepositories: vi.fn(() => [repo]),
      addRepository: vi.fn(() => Promise.resolve(repo)),
      listWorktrees: vi.fn(() => Promise.resolve([main, child])),
      validateBranch: vi.fn(async () => {}),
      launchIdentity: vi.fn(() => Promise.resolve("identity")),
      removalIdentity: vi.fn(() => Promise.resolve("identity")),
      changes: vi.fn(() => Promise.resolve("")),
      cleanupChanges: vi.fn(() => Promise.resolve("")),
      mergedFetchTime: vi.fn(() => 1000),
      mergedDefault: vi.fn(() => Promise.resolve("base")),
      mergedCommit: vi.fn(() => Promise.resolve(false)),
      deleteMergedBranches: vi.fn(() => Promise.resolve([])),
      deleteMergedBranch: vi.fn(async () => {}),
      removeRepository: vi.fn(async () => {}),
      pruneWorktree: vi.fn(async () => {}),
      removeWorktree: vi.fn(async () => {}),
      adoptWorktree: vi.fn(),
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
    placeChild: vi.fn(),
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

const make = (workspace: Workspace, id = "parent") =>
  workspace.sidebarCommand({ kind: "make-orchestrator", id }, confirm);
/** An ordinary agent in the main checkout, then elevated from its session menu. */
const orchestrate = async (workspace: Workspace) => {
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: repo.path, run: "claude" },
    confirm,
  );
  await make(workspace);
};

function principal(): Principal {
  return Object.freeze({
    grantedAt: "2026-10-15T00:00:00.000Z",
    generation: "generation",
    sessionId: "session",
    repository: repo.path,
    worktree: repo.path,
    terminalId: "parent",
    parentId: null,
    role: "orchestrator" as const,
  });
}

it("makes a running agent the orchestrator after the trusted disclosure, without relaunching it", async () => {
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  expect(launch).toHaveBeenCalledOnce();
  expect(launch.mock.calls[0]?.[0].control).toBeUndefined();
  expect(confirm).toHaveBeenLastCalledWith({
    kind: "orchestrator",
    agent: "claude",
    subject: "app · main",
  });
  expect(setRole).toHaveBeenCalledExactlyOnceWith("parent", "orchestrator");
  expect(workspace.snapshot().terminals[0]?.orchestration).toEqual({
    role: "orchestrator",
    active: true,
    children: 0,
    history: [],
  });
  // Already the orchestrator: nothing to confirm.
  confirm.mockClear();
  await make(workspace);
  expect(confirm).not.toHaveBeenCalled();
  void workspace.exited("parent", 0);
  expect(workspace.snapshot().terminals[0]?.orchestration).toMatchObject({ active: false });
});

it("transfers the role only after the human accepts, revoking the previous orchestrator", async () => {
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  launch.mockResolvedValueOnce({ id: "second", attention: "evaluator" });
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: child.path, run: "claude" },
    confirm,
  );
  confirm.mockResolvedValueOnce(false);
  await make(workspace, "second");
  expect(confirm).toHaveBeenLastCalledWith({
    kind: "orchestrator",
    agent: "claude",
    replacing: "Claude Code on main",
    subject: "app · feature",
  });
  expect(workspace.orchestration.active(repo.path)).toBe("parent");
  expect(setRole).not.toHaveBeenCalledWith("parent", "agent");
  await make(workspace, "second");
  expect(setRole.mock.calls.slice(1)).toEqual([
    ["parent", "agent"],
    ["second", "orchestrator"],
  ]);
  expect(workspace.orchestration.active(repo.path)).toBe("second");
  expect(workspace.orchestration.view("parent")).toMatchObject({ active: false });
});

it("rechecks the session and the current orchestrator after the dialog", async () => {
  const workspace = new Workspace(deps);
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: repo.path, run: "claude" },
    confirm,
  );
  confirm.mockImplementationOnce(async () => {
    await workspace.exited("parent", 0);
    return true;
  });
  await expect(make(workspace)).rejects.toThrow("Only a running agent session");
  expect(setRole).not.toHaveBeenCalled();

  const other = new Workspace(deps);
  launch.mockResolvedValueOnce({ id: "first", attention: "evaluator" });
  await other.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: repo.path, run: "claude" },
    confirm,
  );
  launch.mockResolvedValueOnce({ id: "second", attention: "evaluator" });
  await other.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: child.path, run: "claude" },
    confirm,
  );
  confirm.mockImplementationOnce(async () => {
    await make(other, "first");
    return true;
  });
  await expect(make(other, "second")).rejects.toThrow("orchestrator changed");
  expect(other.orchestration.active(repo.path)).toBe("first");
});

it("revokes like an exit: the session keeps running and a later grant keeps its history", async () => {
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  await workspace.orchestration.call(
    principal(),
    "create_worktree",
    { idempotencyKey: "a", branch: "feature" },
    operations,
  );
  await workspace.sidebarCommand({ kind: "revoke-orchestrator", id: "parent" }, confirm);
  expect(setRole).toHaveBeenLastCalledWith("parent", "agent");
  expect(workspace.orchestration.view("parent")).toMatchObject({ active: false });
  expect(workspace.snapshot().terminals[0]?.exited).toBeFalsy();
  await expect(
    workspace.orchestration.call(principal(), "tail", { id: "child" }, operations),
  ).rejects.toMatchObject({ code: "forbidden" });
  // Revoking an ordinary session does nothing.
  setRole.mockClear();
  await workspace.sidebarCommand({ kind: "revoke-orchestrator", id: "parent" }, confirm);
  expect(setRole).not.toHaveBeenCalled();
  await make(workspace);
  const view = workspace.orchestration.view("parent");
  expect(view).toMatchObject({ role: "orchestrator", active: true });
  expect(view?.role === "orchestrator" && view.history.map((entry) => entry.action)).toEqual([
    "create_worktree",
  ]);
});

it("refuses shells, config sessions, owned children and a missing control service", async () => {
  let workspace = new Workspace(deps);
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: repo.path, run: "shell" },
    confirm,
  );
  await expect(make(workspace, "shell")).rejects.toThrow("Only a running agent session");
  await expect(make(workspace, "unknown")).rejects.toThrow("Only a running agent session");
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const tree = (await workspace.orchestration.call(
    principal(),
    "create_worktree",
    { idempotencyKey: "a", branch: "feature" },
    operations,
  )) as Operation;
  launch.mockResolvedValueOnce({ id: "child", attention: "evaluator" });
  await workspace.orchestration.call(
    principal(),
    "launch",
    { idempotencyKey: "b", worktreeId: tree.resultId, agent: "claude" },
    operations,
  );
  await expect(make(workspace, "child")).rejects.toThrow("Take over this session first");
  await workspace.sidebarCommand({ kind: "take-over", id: "child" }, confirm);
  await make(workspace, "child");
  expect(workspace.orchestration.active(repo.path)).toBe("child");

  delete deps.control;
  workspace = new Workspace(deps);
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: repo.path, run: "claude" },
    confirm,
  );
  await expect(make(workspace)).rejects.toThrow("Control service unavailable");
});

it("releases the slot when the session has no control grant", async () => {
  const workspace = new Workspace(deps);
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: repo.path, run: "claude" },
    confirm,
  );
  setRole.mockImplementationOnce(() => {
    throw new Error("not_found");
  });
  await expect(make(workspace)).rejects.toThrow("not_found");
  expect(workspace.orchestration.active(repo.path)).toBeUndefined();
  await make(workspace);
  expect(workspace.orchestration.active(repo.path)).toBe("parent");
});

it.each([
  ["claude", ["--dangerously-skip-permissions"]],
  ["codex", ["-c", 'sandbox_mode="danger-full-access"']],
] as const)(
  "refuses %s children whose defaults bypass permissions before spawning",
  async (agent, args) => {
    const workspace = new Workspace(deps);
    workspace.configure({
      hooks: false,
      agents: { claude: true, codex: true, agy: true },
      agentArguments: { claude: [], codex: [], agy: [], [agent]: args },
    });
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
    launch.mockClear();
    await expect(
      workspace.orchestration.call(
        actor,
        "launch",
        { idempotencyKey: "b", worktreeId: tree.resultId, agent, prompt: "Write tests" },
        operations,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(launch).not.toHaveBeenCalled();
    // The refused worktree stays unused, so it launches once the defaults are fixed.
    workspace.configure({
      hooks: false,
      agents: { claude: true, codex: true, agy: true },
      agentArguments: { claude: [], codex: [], agy: [] },
    });
    launch.mockResolvedValueOnce({ id: "child", attention: "evaluator" });
    await expect(
      workspace.orchestration.call(
        actor,
        "launch",
        { idempotencyKey: "c", worktreeId: tree.resultId, agent },
        operations,
      ),
    ).resolves.toMatchObject({ status: "succeeded", resultId: "child" });
  },
);

it.each([true, false])(
  "launches children with defaults and no confirmation (board placement: %s)",
  async (showNewChildren) => {
    const workspace = new Workspace(deps);
    workspace.configure({
      hooks: false,
      agents: { claude: true, codex: true, agy: true },
      agentArguments: { claude: ["--model", "opus"], codex: [], agy: [] },
      showNewChildren,
    });
    await orchestrate(workspace);
    expect(launch.mock.calls[0]?.[0].defaultArguments).toEqual(["--model", "opus"]);
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
    if (showNewChildren) expect(deps.placeChild).toHaveBeenCalledWith("child", "parent");
    else expect(deps.placeChild).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(launch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        worktree: child.path,
        defaultArguments: ["--model", "opus"],
        sharedCheckout: false,
        mainCheckout: false,
        control: { parentId: "parent" },
        prompt: "Write tests",
      }),
    );
    const row = workspace.snapshot().terminals.find((entry) => entry.id === "child");
    expect(row).toMatchObject({
      launchFlags: ["--model", "opus"],
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
    await workspace.exited("child", 0);
    // A taken-over child cannot be closed by its former parent, even after exit.
    await expect(
      workspace.orchestration.call(
        actor,
        "close",
        { id: "child", idempotencyKey: "refused-close" },
        operations,
      ),
    ).rejects.toThrow("forbidden");
    workspace.removed("child");
    expect(workspace.snapshot().terminals.some((entry) => entry.id === "child")).toBe(false);
  },
);

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
      expect.any(Function),
    );
  });
  expect(deps.dialog).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Remove worktrees?",
      removal: expect.objectContaining({
        item: expect.objectContaining({ branch: "feature" }) as unknown,
      }) as unknown,
    }),
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

it.each([
  "enabled",
  "disabled",
  "unmerged",
  "fetch-failed",
  "dirty",
  "changed-before-delete",
  "disabled-before-delete",
])("orchestrator removal policy: %s", async (mode) => {
  const workspace = new Workspace(deps);
  const configure = (enabled: boolean) => {
    workspace.configure({
      hooks: true,
      agents: { claude: true, codex: true, agy: true },
      autoRemoveMergedWorktrees: enabled,
    });
  };
  configure(mode !== "disabled");
  vi.mocked(deps.worktrees.canAutoRemove).mockResolvedValue(
    !["unmerged", "fetch-failed"].includes(mode),
  );
  if (mode === "dirty") vi.mocked(deps.worktrees.changes).mockResolvedValue("?? file\0");
  if (mode === "changed-before-delete")
    vi.mocked(deps.worktrees.canAutoRemove)
      .mockResolvedValueOnce(true)
      .mockImplementation(() => {
        vi.mocked(deps.worktrees.changes).mockResolvedValue("?? new\0");
        return Promise.resolve(false);
      });
  if (mode === "disabled-before-delete")
    vi.mocked(deps.worktrees.canAutoRemove)
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => {
        configure(false);
        return Promise.resolve(true);
      });
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const actor = principal();
  const tree = (await workspace.orchestration.call(
    actor,
    "create_worktree",
    { idempotencyKey: "auto-tree", branch: "feature" },
    operations,
  )) as Operation;
  await workspace.orchestration.call(
    actor,
    "remove_worktree",
    { idempotencyKey: "auto-remove", worktreeId: tree.resultId },
    operations,
  );
  await vi.waitFor(() => {
    expect(operations.lookup(actor, { idempotencyKey: "auto-remove" })).toMatchObject({
      status: "succeeded",
      resultId: tree.resultId,
    });
  });
  expect(deps.dialog).toHaveBeenCalledTimes(mode === "enabled" ? 0 : 1);
  expect(deps.worktrees.removeWorktree).toHaveBeenCalledWith(
    repo.path,
    child.path,
    ["dirty", "changed-before-delete"].includes(mode),
    "identity",
    expect.any(Function),
  );
  if (mode === "enabled") expect(deps.worktrees.canAutoRemove).toHaveBeenCalledTimes(2);
});

it.each(["declined", "stale"])(
  "records %s fallback review without deleting the worktree",
  async (mode) => {
    const workspace = new Workspace(deps);
    workspace.configure({
      hooks: true,
      agents: { claude: true, codex: true, agy: true },
      autoRemoveMergedWorktrees: true,
    });
    vi.mocked(deps.worktrees.canAutoRemove).mockResolvedValueOnce(true).mockResolvedValue(false);
    deps.dialog = vi.fn(() => {
      if (mode === "stale")
        vi.mocked(deps.worktrees.changes).mockResolvedValue("?? changed-after-review\0");
      return Promise.resolve(mode !== "declined");
    });
    await orchestrate(workspace);
    const operations = new Operations(
      () => Promise.resolve(),
      () => undefined,
    );
    const actor = principal();
    const tree = (await workspace.orchestration.call(
      actor,
      "create_worktree",
      { idempotencyKey: "tree", branch: "feature" },
      operations,
    )) as Operation;
    await workspace.orchestration.call(
      actor,
      "remove_worktree",
      { idempotencyKey: "remove", worktreeId: tree.resultId },
      operations,
    );
    await vi.waitFor(() => {
      expect(operations.lookup(actor, { idempotencyKey: "remove" })).toMatchObject({
        status: mode === "declined" ? "declined" : "failed",
      });
    });
    expect(deps.dialog).toHaveBeenCalledOnce();
    expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
  },
);

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

it("makes CLI-only agents orchestrators, including Antigravity without interactive prompts", async () => {
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
  const workspace = new Workspace(deps);
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: repo.path, run: "agy" },
    confirm,
  );
  await make(workspace);
  expect(confirm).toHaveBeenLastCalledWith({
    kind: "orchestrator",
    agent: "agy",
    subject: "app · main",
  });
  expect(setRole).toHaveBeenCalledWith("parent", "orchestrator");
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
  const save = vi.fn<NonNullable<WorkspaceDependencies["sessions"]>["save"]>(() =>
    Promise.resolve(),
  );
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
    defaultArguments: ["--verbose"],
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
  workspace.orchestration.takeOver("child");
  await workspace.prepareQuit();
  expect(save.mock.calls.at(-1)?.[0].find((entry) => entry.id === "child")).not.toHaveProperty(
    "parentId",
  );
  const before = save.mock.calls.length;
  await workspace.exited("parent", 0);
  expect(save).toHaveBeenCalledTimes(before);
  await workspace.dispose();
});

it("restores a child as exited instead of spawning it with bypass defaults", async () => {
  const { readSessions } = await import("../../../../src/main/workspace/session-store");
  deps.sessions = {
    load: () =>
      Promise.resolve(
        readSessions([
          {
            id: "parent",
            agent: "claude",
            repository: repo.path,
            worktree: repo.path,
            branch: "main",
            conversationId: "parent-conversation",
            running: true,
            orchestrator: { identity: "identity", history: [] },
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
        ]),
      ),
    save: () => Promise.resolve(),
    flush: async () => {},
  };
  launch.mockImplementation((request) =>
    Promise.resolve({ id: request.terminalId ?? "new", attention: "evaluator" }),
  );
  const workspace = new Workspace(deps);
  workspace.configure({
    hooks: false,
    agents: { claude: true, codex: true, agy: true },
    agentArguments: { claude: ["--dangerously-skip-permissions"], codex: [], agy: [] },
  });
  await workspace.restore();
  await workspace.restartSaved();
  expect(launch.mock.calls.map(([request]) => request.terminalId)).toEqual(["parent"]);
  expect(workspace.snapshot().terminals.find(({ id }) => id === "child")).toMatchObject({
    exited: true,
  });
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
      // The reused ID resets the renderer row, so main's snapshot must advance with it.
      expect(workspace.snapshot().terminals[0]?.launchVersion).toBe(1);
      await workspace.exited("restored", 0);
      expect(save.mock.calls.at(-1)?.[0][0]?.running).toBe(false);
      workspace.cancelQuit();
    }
    await workspace.dispose();
  },
);

it.each([false, true])(
  "starts Codex without notifier consent during automatic restore (config=%s)",
  async (config) => {
    const { readSessions } = await import("../../../../src/main/workspace/session-store");
    scanned = {
      path: "/bin",
      warning: null,
      agents: [
        {
          id: "codex",
          path: "/bin/codex",
          version: "codex-cli 0.161.0",
          hooks: true,
          mcp: true,
          reason: "",
        },
      ],
    };
    deps.config = { root: "/config", cliDirectory: "/cli", check: () => Promise.resolve() };
    const location = config ? "/config" : repo.path;
    const saved = readSessions([
      {
        id: "codex",
        agent: "codex",
        repository: location,
        worktree: location,
        branch: config ? null : "main",
        ...(config ? { config: true } : {}),
        running: true,
        conversationId: "saved-codex",
      },
    ]);
    deps.sessions = {
      load: () => Promise.resolve(saved),
      save: () => Promise.resolve(),
      flush: () => Promise.resolve(),
    };
    launch.mockResolvedValueOnce({ id: "codex", attention: "evaluator" });
    const workspace = new Workspace(deps);
    await workspace.restore();
    await workspace.restartSaved();
    expect(launch).toHaveBeenCalledOnce();
    expect(workspace.snapshot().terminals).toMatchObject([
      { exited: false, conversationId: "saved-codex" },
    ]);
    await workspace.dispose();
  },
);

it("binds re-granted authority to the saved identity across asynchronous launch checks", async () => {
  const { readSessions } = await import("../../../../src/main/workspace/session-store");
  const saved = readSessions([
    {
      id: "parent",
      agent: "claude",
      repository: repo.path,
      worktree: repo.path,
      branch: "main",
      conversationId: "saved",
      running: true,
      orchestrator: { identity: "identity", history: [] },
    },
  ]);
  deps.sessions = {
    load: () => Promise.resolve(saved),
    save: () => Promise.resolve(),
    flush: () => Promise.resolve(),
  };
  vi.mocked(deps.worktrees, true)
    .launchIdentity.mockResolvedValueOnce("identity")
    .mockResolvedValue("replacement");
  const workspace = new Workspace(deps);
  await workspace.restore();
  await workspace.restartSaved();
  expect(launch).not.toHaveBeenCalled();
  expect(workspace.snapshot().terminals).toMatchObject([
    { exited: true, conversationId: "saved", roleNotRestored: true },
  ]);
  await workspace.dispose();
});

it("sends child input through the workspace path and tracks input/output revisions", async () => {
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  const actor = principal();
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
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
  deps.verdicts.classify = vi.fn<WorkspaceDependencies["verdicts"]["classify"]>(() =>
    Promise.resolve({
      id: "question",
      terminalId: "child",
      timestamp: new Date().toISOString(),
      verdict: {
        state: "needs_input",
        signal: "pattern:question",
        reason: "Question",
        attentionKind: "question",
        confidence: 0.9,
      },
    }),
  );
  tail.mockResolvedValue(["Which file should I change?"]);
  const reply = vi.fn(async (_id: string, _data: ChildInput) => {});
  deps.terminals.childInput = reply;
  await workspace.quiet("child");
  const { SessionMetadata } = await import("../../../../src/main/control/metadata");
  const metadata = new SessionMetadata(() => workspace.snapshot().terminals);
  const question = metadata.read(actor, "session_state", { id: "child" }) as {
    revision: string;
    verdictId: string;
    attentionKind: string;
  };
  expect(question.attentionKind).toBe("question");
  const proposed = (await workspace.orchestration.call(
    actor,
    "prompt",
    {
      idempotencyKey: "c",
      id: "child",
      text: "src/app.ts",
    },
    operations,
  )) as Operation;
  await vi.waitFor(() => {
    expect(operations.lookup(actor, { operationId: proposed.operationId }).status).toBe(
      "succeeded",
    );
  });
  expect(reply).toHaveBeenCalledExactlyOnceWith("child", { kind: "prompt", text: "src/app.ts" });
  expect(workspace.snapshot().terminals.find((row) => row.id === "child")?.inputRevision).toBe(1);
  workspace.output("child");
  expect(workspace.snapshot().terminals.find((row) => row.id === "child")?.outputRevision).toBe(1);
  await workspace.sidebarCommand({ kind: "take-over", id: "child" }, confirm);
});

it("exposes durable history and clearing and refuses authority changes when intent cannot persist", async () => {
  const audit = new ControlStore("/unused");
  const human = vi.spyOn(audit, "human").mockResolvedValue();
  const read = vi.spyOn(audit, "read").mockResolvedValue({ entries: [], total: 0 });
  const clear = vi.spyOn(audit, "clearAudit").mockResolvedValue();
  const original = deps.control;
  if (!original) throw new Error("Missing control");
  deps.control = async () => ({ ...(await original()), audit });
  const workspace = new Workspace(deps);
  const query = { search: "child", action: "reply", status: "", offset: 0 };
  expect(await workspace.actionLog(query)).toEqual({ entries: [], total: 0 });
  expect(read).toHaveBeenCalledWith(query);
  await workspace.clearActionLog();
  expect(clear).toHaveBeenCalledOnce();
  await orchestrate(workspace);
  expect(human).toHaveBeenCalledWith(
    "make_orchestrator",
    "parent",
    repo.path,
    repo.path,
    "parent",
    "pending_confirmation",
    expect.any(String),
  );
  await expect(
    workspace.sidebarCommand({ kind: "take-over", id: "parent" }, confirm),
  ).rejects.toThrow("This session has no orchestrator");
  expect(human).toHaveBeenLastCalledWith(
    "take_over",
    "parent",
    repo.path,
    repo.path,
    "parent",
    "refused",
    expect.any(String),
  );
  human.mockRejectedValueOnce(new Error("disk full"));
  await expect(
    workspace.sidebarCommand({ kind: "revoke-orchestrator", id: "parent" }, confirm),
  ).rejects.toThrow("disk full");
  expect(workspace.snapshot().terminals[0]?.orchestration).toMatchObject({ active: true });
});
it("reports unavailable history when the control service is absent", async () => {
  const unavailable = { ...deps };
  delete unavailable.control;
  const workspace = new Workspace(unavailable);
  await expect(workspace.actionLog({})).rejects.toThrow("Action log unavailable");
  await expect(workspace.clearActionLog()).rejects.toThrow("Action log unavailable");
});

it.each([
  "valid",
  "main",
  "foreign",
  "missing",
  "unmanaged",
  "locked",
  "bare",
  "prunable",
  "detached",
  "identity",
  "unreadable",
])("restores exited child ownership only for an eligible managed checkout: %s", async (mode) => {
  const { readSessions } = await import("../../../../src/main/workspace/session-store");
  const path = mode === "main" ? repo.path : child.path;
  const entries = readSessions([
    {
      id: "parent",
      agent: "claude",
      repository: repo.path,
      worktree: repo.path,
      branch: "main",
      conversationId: "conversation",
      running: true,
      orchestrator: {
        identity: "identity",
        history: [],
        ...(mode === "identity"
          ? { worktrees: [{ path, identity: "previous", state: "used" }] }
          : {}),
      },
    },
    {
      id: "exited-child",
      agent: "claude",
      repository: mode === "foreign" ? "/another/repo" : repo.path,
      worktree: path,
      branch: "untrusted",
      running: false,
      parentId: "parent",
    },
  ]);
  deps.sessions = {
    load: () => Promise.resolve(entries),
    save: vi.fn(() => Promise.resolve()),
    flush: async () => {},
  };
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
    main,
    ...(mode === "missing" || mode === "foreign"
      ? []
      : [
          {
            ...child,
            managed: mode !== "unmanaged",
            locked: mode === "locked",
            bare: mode === "bare",
            prunable: mode === "prunable",
            branch: mode === "detached" ? null : child.branch,
          },
        ]),
  ]);
  vi.mocked(deps.worktrees.launchIdentity).mockImplementation((_repository, checkout) =>
    checkout === child.path && mode === "unreadable"
      ? Promise.reject(new Error("missing path"))
      : Promise.resolve("identity"),
  );
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: false, agents: { claude: true, codex: true, agy: true } });
  await workspace.restore();
  await workspace.restartSaved();
  const owned = workspace.orchestration.ownedWorktrees("parent");
  expect(owned).toEqual(
    mode === "valid" ? [{ path: child.path, identity: "identity", state: "used" }] : [],
  );
  if (mode === "valid") {
    await workspace.orchestration.call(
      principal(),
      "remove_worktree",
      {
        worktreeId: (await import("../../../../src/main/control/metadata")).locationId(path),
        idempotencyKey: "remove-restored",
      },
      new Operations(
        async () => {},
        () => 1000,
      ),
    );
    await vi.waitFor(() => {
      expect(deps.worktrees.removeWorktree).toHaveBeenCalled();
    });
  }
  await workspace.dispose();
});

it.each(["dirty", "identity", "failure", "actor"])(
  "rechecks authority, identity and dirty state for each approved item (%s)",
  async (mode) => {
    const { RemovalReview } = await import("../../../../src/main/confirmations/removal-review");
    const paths = ["/trees/app/one", "/trees/app/two", "/trees/app/three"];
    const trees = paths.map((path, index) => ({
      ...child,
      path,
      branch: `branch-${String(index)}`,
    }));
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([main, ...trees]);
    let next = 0;
    vi.mocked(deps.worktrees.createWorktree).mockImplementation(() =>
      Promise.resolve({
        path: paths[next++] ?? "",
        outcome: "new",
      }),
    );
    let approved = false;
    vi.mocked(deps.worktrees.changes).mockImplementation((_repository, path) =>
      Promise.resolve(approved && path === paths[1] && mode === "dirty" ? "?? changed\0" : ""),
    );
    vi.mocked(deps.worktrees.launchIdentity).mockImplementation((_repository, path) =>
      Promise.resolve(
        approved && path === paths[1] && mode === "identity" ? "replacement" : "identity",
      ),
    );
    vi.mocked(deps.worktrees.removeWorktree).mockImplementation((_repository, path) => {
      return path === paths[1] && mode === "failure"
        ? Promise.reject(Error("git removal failed"))
        : Promise.resolve();
    });
    let feed: RemovalFeed | undefined;
    let resolve: (value: boolean) => void = () => undefined;
    const review = new RemovalReview((content) => {
      feed = content.removalFeed;
      return new Promise<boolean>((answer) => {
        resolve = answer;
      });
    });
    deps.dialog = vi.fn<NonNullable<WorkspaceDependencies["dialog"]>>((content, signal) => {
      if (!content.removal) throw Error("missing removal snapshot");
      return review.request(content.removal.group, content.removal.item, signal);
    });
    const workspace = new Workspace(deps);
    await orchestrate(workspace);
    const actor = principal();
    let revokedItem: string | null = null;
    const operations = new Operations(
      () => Promise.resolve(),
      (current) => {
        if (current !== actor) throw Error("foreign actor");
        if (mode === "actor" && revokedItem && approved) {
          // Simulate revocation during a final filesystem read, after approval.
          throw Error("revoked");
        }
      },
    );
    const created: Operation[] = [];
    for (const tree of trees) {
      created.push(
        (await workspace.orchestration.call(
          actor,
          "create_worktree",
          { idempotencyKey: tree.branch, branch: tree.branch },
          operations,
        )) as Operation,
      );
    }
    const pending: Operation[] = [];
    for (const tree of created) {
      pending.push(
        (await workspace.orchestration.call(
          actor,
          "remove_worktree",
          { idempotencyKey: `remove-${tree.operationId}`, worktreeId: tree.resultId },
          operations,
        )) as Operation,
      );
    }
    await vi.waitFor(() => {
      expect(feed?.current()).toHaveLength(3);
    });
    approved = true;
    if (mode === "actor") {
      vi.mocked(deps.worktrees.changes).mockImplementation((_repository, path) => {
        if (path === paths[1]) revokedItem = pending[1]?.operationId ?? null;
        return Promise.resolve("");
      });
    }
    feed?.select(pending.map((item) => item.operationId));
    resolve(true);
    if (mode === "actor") {
      await vi.waitFor(() => {
        expect(
          vi.mocked(deps.worktrees.changes).mock.calls.filter((call) => call[1] === paths[1])
            .length,
        ).toBeGreaterThan(1);
      });
      // Authority failure must prevent this deletion; revoke all operations as the runtime does.
      operations.revoke(actor);
      expect(
        vi.mocked(deps.worktrees.removeWorktree).mock.calls.some((call) => call[1] === paths[1]),
      ).toBe(false);
    } else {
      await vi.waitFor(() => {
        expect(
          pending.map((item) => operations.lookup(actor, { operationId: item.operationId }).status),
        ).toEqual(["succeeded", "failed", "succeeded"]);
      });
      expect(
        pending.map((item) => operations.lookup(actor, { operationId: item.operationId }).reason),
      ).toEqual(["completed", "error", "completed"]);
      expect(vi.mocked(deps.worktrees.removeWorktree).mock.calls.map((call) => call[1])).toEqual(
        mode === "failure" ? paths : [paths[0], paths[2]],
      );
      for (const path of paths) {
        expect(
          vi.mocked(deps.worktrees.launchIdentity).mock.calls.filter((call) => call[1] === path)
            .length,
        ).toBeGreaterThan(2);
      }
    }
  },
);

it.each(["revoke", "intent-write-failed"])(
  "automatic removal records indeterminate effects on %s",
  async (mode) => {
    const workspace = new Workspace(deps);
    workspace.configure({
      hooks: true,
      agents: { claude: true, codex: true, agy: true },
      autoRemoveMergedWorktrees: true,
    });
    vi.mocked(deps.worktrees.canAutoRemove).mockResolvedValue(true);
    await orchestrate(workspace);
    const operations = new Operations(
      (record) =>
        record.operation.action === "remove_worktree" &&
        record.operation.status === "running" &&
        mode === "intent-write-failed"
          ? Promise.reject(new Error("disk full"))
          : Promise.resolve(),
      () => undefined,
    );
    const actor = principal();
    const tree = (await workspace.orchestration.call(
      actor,
      "create_worktree",
      { idempotencyKey: "tree", branch: "feature" },
      operations,
    )) as Operation;
    let release = () => {};
    if (mode === "revoke")
      vi.mocked(deps.worktrees.removeWorktree).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
    await workspace.orchestration.call(
      actor,
      "remove_worktree",
      { idempotencyKey: "remove", worktreeId: tree.resultId },
      operations,
    );
    if (mode === "revoke") {
      await vi.waitFor(() => {
        expect(deps.worktrees.removeWorktree).toHaveBeenCalledOnce();
      });
      expect(operations.lookup(actor, { idempotencyKey: "remove" }).status).toBe("running");
      operations.revoke(actor);
      release();
    }
    await vi.waitFor(() => {
      const view = workspace.orchestration.view("parent");
      expect(
        view?.role === "orchestrator" &&
          view.history.find((row) => row.action === "remove_worktree")?.status,
      ).toBe("indeterminate");
    });
    expect(operations.lookup(actor, { idempotencyKey: "remove" }).status).toBe("indeterminate");
    expect(deps.dialog).not.toHaveBeenCalled();
    if (mode === "intent-write-failed")
      expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
  },
);

it.each(["revoke-review", "review-write-failed"])(
  "automatic fallback records %s before any effect",
  async (mode) => {
    const workspace = new Workspace(deps);
    workspace.configure({
      hooks: true,
      agents: { claude: true, codex: true, agy: true },
      autoRemoveMergedWorktrees: true,
    });
    vi.mocked(deps.worktrees.canAutoRemove).mockResolvedValueOnce(true).mockResolvedValue(false);
    deps.dialog = vi.fn<NonNullable<WorkspaceDependencies["dialog"]>>(
      (_content, signal) =>
        new Promise<boolean>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve(false);
            },
            { once: true },
          );
        }),
    );
    await orchestrate(workspace);
    let pendingWrites = 0;
    const operations = new Operations(
      (record) => {
        if (
          record.operation.action === "remove_worktree" &&
          record.operation.status === "pending_confirmation"
        ) {
          pendingWrites++;
          if (mode === "review-write-failed" && pendingWrites === 2)
            return Promise.reject(new Error("disk full"));
        }
        return Promise.resolve();
      },
      () => undefined,
    );
    const actor = principal();
    const tree = (await workspace.orchestration.call(
      actor,
      "create_worktree",
      { idempotencyKey: "tree", branch: "feature" },
      operations,
    )) as Operation;
    await workspace.orchestration.call(
      actor,
      "remove_worktree",
      { idempotencyKey: "remove", worktreeId: tree.resultId },
      operations,
    );
    if (mode === "revoke-review") {
      await vi.waitFor(() => {
        expect(deps.dialog).toHaveBeenCalledOnce();
      });
      expect(operations.lookup(actor, { idempotencyKey: "remove" }).status).toBe(
        "pending_confirmation",
      );
      operations.revoke(actor);
      workspace.orchestration.revoke("parent");
    }
    const status = mode === "revoke-review" ? "cancelled" : "indeterminate";
    await vi.waitFor(() => {
      const view = workspace.orchestration.view("parent");
      expect(
        view?.role === "orchestrator" &&
          view.history.find((row) => row.action === "remove_worktree")?.status,
      ).toBe(status);
    });
    expect(operations.lookup(actor, { idempotencyKey: "remove" }).status).toBe(status);
    expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
    if (mode === "review-write-failed") expect(deps.dialog).not.toHaveBeenCalled();
  },
);
it("adopts under repository and branch locks, then releases them on completion", async () => {
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const pending = Promise.withResolvers<{ path: string; branch: string; identity: string }>();
  vi.mocked(deps.worktrees.adoptWorktree).mockImplementationOnce(
    (_repo, _number, _unused, revalidate) => {
      revalidate(undefined, "feature");
      revalidate(undefined, "feature");
      return pending.promise;
    },
  );
  const call = (key: string, params: Record<string, unknown>) =>
    workspace.orchestration.call(
      principal(),
      "create_worktree",
      { idempotencyKey: key, ...params },
      operations,
    );
  const first = call("adopt", { pullRequest: 337 });
  await vi.waitFor(() => {
    expect(deps.worktrees.adoptWorktree).toHaveBeenCalledOnce();
  });
  await expect(call("duplicate", { pullRequest: 337 })).rejects.toThrow("branch_in_use");
  expect(await call("branch-conflict", { branch: "feature" })).toMatchObject({ status: "failed" });
  pending.resolve({ path: child.path, branch: "feature", identity: "identity" });
  expect(await first).toMatchObject({ status: "succeeded" });
  expect(await call("branch-unlocked", { branch: "feature" })).toMatchObject({
    status: "succeeded",
  });
  await workspace.dispose();
});
it("refuses adoption when a branch launch already holds its lock", async () => {
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const pending = Promise.withResolvers<{ path: string; outcome: "new" }>();
  vi.mocked(deps.worktrees.createWorktree).mockReturnValueOnce(pending.promise);
  const first = workspace.orchestration.call(
    principal(),
    "create_worktree",
    { idempotencyKey: "branch", branch: "feature" },
    operations,
  );
  await vi.waitFor(() => {
    expect(deps.worktrees.createWorktree).toHaveBeenCalledOnce();
  });
  vi.mocked(deps.worktrees.adoptWorktree).mockImplementationOnce(
    (_repo, _number, _unused, revalidate) => {
      revalidate(undefined, "feature");
      return Promise.resolve({ path: child.path, branch: "feature", identity: "identity" });
    },
  );
  await expect(
    workspace.orchestration.call(
      principal(),
      "create_worktree",
      { idempotencyKey: "adopt", pullRequest: 337 },
      operations,
    ),
  ).rejects.toThrow("branch_in_use");
  pending.resolve({ path: child.path, outcome: "new" });
  await first;
  await workspace.dispose();
});
it("refuses reuse with a live human session in the unused checkout", async () => {
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  launch.mockResolvedValueOnce({ id: "human", attention: "evaluator" });
  await workspace.launch({
    agent: "claude",
    repository: repo.path,
    worktree: child.path,
    cols: 80,
    rows: 24,
  });
  vi.mocked(deps.worktrees.adoptWorktree).mockImplementationOnce(
    (_repo, _number, _unused, revalidate) => {
      revalidate(child.path, "feature");
      return Promise.resolve({ path: child.path, branch: "feature", identity: "identity" });
    },
  );
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  await expect(
    workspace.orchestration.call(
      principal(),
      "create_worktree",
      { idempotencyKey: "adopt", pullRequest: 337 },
      operations,
    ),
  ).rejects.toThrow("branch_in_use");
  await workspace.dispose();
});

it("does not confuse a valid adoption-named head with the PR reservation lock", async () => {
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  vi.mocked(deps.worktrees.adoptWorktree).mockImplementationOnce(
    (_repo, _number, _unused, revalidate) => {
      revalidate(undefined, "adopt-pr-337");
      return Promise.resolve({ path: child.path, branch: "adopt-pr-337", identity: "identity" });
    },
  );
  expect(
    await workspace.orchestration.call(
      principal(),
      "create_worktree",
      { idempotencyKey: "named-head", pullRequest: 337 },
      operations,
    ),
  ).toMatchObject({ status: "succeeded" });
  await workspace.dispose();
});

it("closes an exited child through the normal session removal path", async () => {
  const kill = vi.spyOn(deps.terminals, "kill");
  const forget = vi.spyOn(deps.verdicts, "forget");
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  const actor = principal();
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const tree = (await workspace.orchestration.call(
    actor,
    "create_worktree",
    { branch: "feature", idempotencyKey: "tree" },
    operations,
  )) as Operation;
  launch.mockResolvedValueOnce({ id: "child", attention: "evaluator" });
  await workspace.orchestration.call(
    actor,
    "launch",
    { worktreeId: tree.resultId, agent: "claude", idempotencyKey: "launch" },
    operations,
  );
  await workspace.exited("child", 0);
  const result = await workspace.orchestration.call(
    actor,
    "close",
    { id: "child", idempotencyKey: "close" },
    operations,
  );
  expect(result).toMatchObject({ status: "succeeded" });
  expect(kill).toHaveBeenCalledWith("child");
  expect(forget).toHaveBeenCalledWith("child");
  expect(workspace.snapshot().terminals.some((row) => row.id === "child")).toBe(false);
  expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
});

it("projects unread child attention and clears on human focus without changing execution", async () => {
  let time = 1000;
  deps.now = () => time;
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  const configure = (unreadChildMinutes: number) => {
    workspace.configure({
      hooks: false,
      agents: { claude: true, codex: true, agy: true },
      unreadChildMinutes,
    });
  };
  configure(1);
  const actor = principal();
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const tree = (await workspace.orchestration.call(
    actor,
    "create_worktree",
    { idempotencyKey: "unread-tree", branch: "feature" },
    operations,
  )) as Operation;
  launch.mockResolvedValueOnce({ id: "child", attention: "evaluator" });
  await workspace.orchestration.call(
    actor,
    "launch",
    { idempotencyKey: "unread-launch", worktreeId: tree.resultId, agent: "claude" },
    operations,
  );
  await workspace.exited("child", 0);
  time += 59999;
  workspace.refresh();
  const parent = () => workspace.snapshot().terminals.find((row) => row.id === "parent");
  expect(parent()?.state?.reason).not.toBe("Child report unread");
  time++;
  workspace.refresh();
  expect(parent()?.state).toMatchObject({
    state: "needs_input",
    reason: "Child report unread",
    signal: "orchestration:unread",
  });
  configure(0);
  expect(parent()?.state?.reason).not.toBe("Child report unread");
  configure(1);
  expect(parent()?.state?.reason).toBe("Child report unread");
  const execution = parent()?.execution;
  workspace.focusOrchestrator("foreign");
  expect(parent()?.state?.reason).toBe("Child report unread");
  workspace.focusOrchestrator("parent");
  expect(parent()?.state?.reason).not.toBe("Child report unread");
  expect(parent()?.execution).toEqual(execution);
  await workspace.dispose();
});

it("keeps the orchestrator's own attention and verdict over an unread child reminder", async () => {
  let time = 1000;
  deps.now = () => time;
  const workspace = new Workspace(deps);
  await orchestrate(workspace);
  workspace.configure({
    hooks: false,
    agents: { claude: true, codex: true, agy: true },
    unreadChildMinutes: 1,
  });
  const actor = principal();
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const tree = (await workspace.orchestration.call(
    actor,
    "create_worktree",
    { idempotencyKey: "own-tree", branch: "feature" },
    operations,
  )) as Operation;
  launch.mockResolvedValueOnce({ id: "child", attention: "evaluator" });
  await workspace.orchestration.call(
    actor,
    "launch",
    { idempotencyKey: "own-launch", worktreeId: tree.resultId, agent: "claude" },
    operations,
  );
  await workspace.exited("child", 0);
  time += 60000;
  workspace.refresh();
  const parent = () => workspace.snapshot().terminals.find((row) => row.id === "parent");
  expect(parent()?.state?.reason).toBe("Child report unread");
  deps.verdicts.classify = vi.fn<WorkspaceDependencies["verdicts"]["classify"]>(() =>
    Promise.resolve({
      id: "parent-question",
      terminalId: "parent",
      timestamp: new Date().toISOString(),
      verdict: {
        state: "needs_input",
        signal: "pattern:question",
        reason: "Question",
        attentionKind: "question",
        confidence: 0.9,
      },
    }),
  );
  tail.mockResolvedValue(["Merge this PR?"]);
  await workspace.quiet("parent");
  expect(parent()?.state).toMatchObject({
    state: "needs_input",
    reason: "Question",
    attentionKind: "question",
    verdictId: "parent-question",
  });
  await workspace.dispose();
});

it.each([false, true])(
  "runs review steps through launches and author resume (resume failure: %s)",
  async (resumeFails) => {
    const snapshot = vi
      .spyOn(reviewSnapshots, "reviewSnapshot")
      .mockResolvedValue({ head: "head", digest: "same" });
    const forge = new ForgeTracking(
      "/unused",
      () => Promise.resolve(undefined),
      () => {},
    );
    vi.spyOn(forge, "track").mockImplementation(() => {});
    vi.spyOn(forge, "read").mockReturnValue({
      number: 7,
      headSha: "head",
      state: "OPEN",
      requiredChecks: "success",
    });
    scanned = { ...scanned, agents: scanned.agents.map((agent) => ({ ...agent, resume: true })) };
    const workspace = new Workspace({ ...deps, forge });
    await orchestrate(workspace);
    let next = 0;
    launch.mockImplementation((request) => {
      request.beforeSpawn?.();
      return Promise.resolve({
        id: request.terminalId ?? `child-${String(++next)}`,
        attention: "evaluator",
        conversationId: request.conversationId ?? "author-conversation",
      });
    });
    const actor = principal();
    const operations = new Operations(
      () => Promise.resolve(),
      () => {},
    );
    const call = (method: string, params: Record<string, unknown>) =>
      workspace.orchestration.call(actor, method, params, operations);
    const tree = await call("create_worktree", { branch: "feature", idempotencyKey: "tree" });
    if (typeof tree !== "object" || tree === null || !("resultId" in tree))
      throw new Error("missing tree");
    await call("launch", {
      worktreeId: tree.resultId,
      agent: "claude",
      prompt: "Build",
      review: {},
      idempotencyKey: "launch",
    });
    const report = (
      id: string,
      seq: number,
      review?:
        | { verdict: "clean" }
        | {
            verdict: "findings";
            findings: { file: string; line: number; summary: string; scenario: string }[];
          },
    ) => {
      workspace.orchestration.handoffs.restore(id, [
        ...workspace.orchestration.handoffs.entries(id),
        {
          seq,
          status: "done",
          summary: "Result",
          links: [],
          timestamp: new Date(0).toISOString(),
          ...(review ? { review } : {}),
        },
      ]);
    };
    expect(workspace.snapshot().terminals.find((row) => row.id === "child-1")?.review?.phase).toBe(
      "building",
    );
    report("child-1", 1);
    await workspace.exited("child-1", 0);
    await vi.waitFor(() => {
      expect(workspace.orchestration.reviews.view("child-1")).toMatchObject({
        phase: "reviewing",
        waiting: false,
      });
    });
    expect(snapshot).toHaveBeenCalledWith(deps.worktrees, repo.path, child.path, "identity");
    expect(deps.placeChild).toHaveBeenLastCalledWith("child-2", "parent");
    workspace.configure({
      hooks: false,
      agents: { claude: true, codex: true, agy: true },
      showNewChildren: false,
    });
    vi.mocked(deps.placeChild)?.mockClear();
    if (resumeFails) launch.mockRejectedValueOnce(new Error("Resume failed"));
    report("child-2", 1, {
      verdict: "findings",
      findings: [{ file: "a.ts", line: 1, summary: "Wrong", scenario: "Zero" }],
    });
    await workspace.exited("child-2", 0);
    if (resumeFails) {
      await vi.waitFor(() => {
        expect(workspace.orchestration.reviews.view("child-1")?.phase).toBe("escalated");
      });
      expect(workspace.snapshot().terminals.find((row) => row.id === "child-1")).toMatchObject({
        exited: true,
        dormant: true,
        review: { reason: "launch failed" },
      });
      workspace.orchestration.disposeUnreadChildren();
      snapshot.mockRestore();
      return;
    }
    await vi.waitFor(() => {
      expect(workspace.orchestration.reviews.view("child-1")).toMatchObject({
        phase: "fixing",
        waiting: false,
      });
    });
    expect(launch.mock.calls.at(-1)?.[0]).toMatchObject({
      terminalId: "child-1",
      conversationId: "author-conversation",
    });
    expect(launch.mock.calls.at(-1)?.[0].prompt).toContain("Quoted review notes");
    expect(workspace.orchestration.handoffs.entries("child-1")).toHaveLength(1);
    report("child-1", 2);
    await workspace.exited("child-1", 0);
    await vi.waitFor(() => {
      expect(workspace.orchestration.reviews.view("child-1")).toMatchObject({
        phase: "reviewing",
        waiting: false,
      });
    });
    expect(deps.placeChild).not.toHaveBeenCalled();
    report("child-3", 1, { verdict: "clean" });
    await workspace.exited("child-3", 0);
    await vi.waitFor(() => {
      expect(workspace.orchestration.reviews.view("child-1")?.phase).toBe("clean");
    });
    expect(workspace.snapshot().terminals.find((row) => row.id === "parent")?.state).toMatchObject({
      state: "needs_input",
      reason: "Review clean",
    });
    workspace.focusOrchestrator("parent");
    expect(workspace.orchestration.reviewUnreadAt("parent")).toBeUndefined();
    workspace.orchestration.disposeUnreadChildren();
    snapshot.mockRestore();
  },
);
