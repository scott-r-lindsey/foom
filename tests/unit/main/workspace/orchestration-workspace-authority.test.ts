import { expect, it, vi } from "vitest";
import { Operations } from "../../../../src/main/control/operations";
import type { Operation } from "../../../../src/main/control/types";
import {
  repo,
  child,
  scan,
  deps,
  launch,
  scans,
  confirm,
  setRole,
  make,
  orchestrate,
  principal,
  createWorkspace,
} from "./orchestration-workspace-fixture";

it("makes a running agent the orchestrator after the trusted disclosure, without relaunching it", async () => {
  const workspace = createWorkspace(deps);
  await orchestrate(workspace);
  expect(launch).toHaveBeenCalledOnce();
  expect(launch.mock.calls[0]?.[0].control).toBeUndefined();
  expect(confirm).toHaveBeenLastCalledWith({
    kind: "orchestrator",
    restoreOnResume: true,
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
  const workspace = createWorkspace(deps);
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
    restoreOnResume: true,
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
  const workspace = createWorkspace(deps);
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

  const other = createWorkspace(deps);
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
  const workspace = createWorkspace(deps);
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
  // Revoking a retired orchestrator also cancels pending resume authority.
  setRole.mockClear();
  await workspace.sidebarCommand({ kind: "revoke-orchestrator", id: "parent" }, confirm);
  expect(setRole).toHaveBeenCalledExactlyOnceWith("parent", "agent");
  await make(workspace);
  const view = workspace.orchestration.view("parent");
  expect(view).toMatchObject({ role: "orchestrator", active: true });
  expect(view?.role === "orchestrator" && view.history.map((entry) => entry.action)).toEqual([
    "create_worktree",
  ]);
});

it("refuses shells, config sessions, owned children and a missing control service", async () => {
  let workspace = createWorkspace(deps);
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
  workspace = createWorkspace(deps);
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: repo.path, run: "claude" },
    confirm,
  );
  await expect(make(workspace)).rejects.toThrow("Control service unavailable");
});

it("releases the slot when the session has no control grant", async () => {
  const workspace = createWorkspace(deps);
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

it("makes CLI-only agents orchestrators, including Antigravity without interactive prompts", async () => {
  scans.current = {
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
  const workspace = createWorkspace(deps);
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

it("resumes an exited orchestrator in its tile with fresh role credentials and its children", async () => {
  const workspace = createWorkspace(deps);
  const initial = { id: "parent", attention: "evaluator" as const, conversationId: "saved-123" };
  launch.mockResolvedValueOnce(initial);
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const tree = (await workspace.orchestration.call(
    principal(),
    "create_worktree",
    {
      branch: "feature",
      idempotencyKey: "resume-tree",
    },
    operations,
  )) as Operation;
  launch.mockResolvedValueOnce({ id: "child", attention: "evaluator" });
  await workspace.orchestration.call(
    principal(),
    "launch",
    {
      worktreeId: tree.resultId,
      agent: "claude",
      idempotencyKey: "resume-child",
    },
    operations,
  );
  await workspace.exited("parent", 0);
  launch.mockResolvedValueOnce({ id: "parent", attention: "evaluator" });
  await workspace.sidebarCommand({ kind: "resume", id: "parent" }, confirm);
  expect(launch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      terminalId: "parent",
      conversationId: "saved-123",
      control: { role: "orchestrator" },
    }),
  );
  expect(workspace.orchestration.view("parent")).toMatchObject({ active: true, children: 1 });
  expect(workspace.orchestration.view("child")).toMatchObject({
    parentId: "parent",
    takenOver: false,
  });
});

for (const action of [
  "revoke",
  "revoke-after-exit",
  "new-conversation",
  "transfer",
  "identity",
  "failure",
] as const) {
  it(`guards orchestrator resume against ${action}`, async () => {
    const workspace = createWorkspace(deps);
    const initial = { id: "parent", attention: "evaluator" as const, conversationId: "saved-123" };
    launch.mockResolvedValueOnce(initial);
    await orchestrate(workspace);
    if (action === "revoke")
      await workspace.sidebarCommand({ kind: "revoke-orchestrator", id: "parent" }, confirm);
    await workspace.exited("parent", 0);
    if (action === "revoke-after-exit")
      await workspace.sidebarCommand({ kind: "revoke-orchestrator", id: "parent" }, confirm);
    if (action === "transfer") {
      launch.mockResolvedValueOnce({ id: "second", attention: "evaluator" });
      await workspace.sidebarCommand(
        { kind: "launch", repository: repo.path, worktree: child.path, run: "claude" },
        confirm,
      );
      await make(workspace, "second");
    }
    if (action === "identity") deps.worktrees.launchIdentity = () => Promise.resolve("replaced");
    launch.mockResolvedValueOnce({ id: "parent", attention: "evaluator" });
    if (action === "failure") launch.mockRejectedValueOnce(new Error("spawn failed"));
    const resume = () =>
      workspace.sidebarCommand(
        { kind: action === "new-conversation" ? "new-conversation" : "resume", id: "parent" },
        confirm,
      );
    if (action === "identity") {
      await expect(resume()).rejects.toThrow("Repository identity changed");
      expect(workspace.orchestration.active(repo.path)).toBeUndefined();
    } else if (action === "failure") {
      // The first attempt succeeds; the following exit and failed resume release the slot.
      await resume();
      await workspace.exited("parent", 0);
      await expect(resume()).rejects.toThrow("spawn failed");
      expect(workspace.orchestration.active(repo.path)).toBeUndefined();
    } else {
      await resume();
      expect(launch.mock.calls.at(-1)?.[0].control).toBeUndefined();
      expect(workspace.orchestration.active(repo.path)).toBe(
        action === "transfer" ? "second" : undefined,
      );
    }
  });
}

it("refuses to recover a prior role into a replaced repository at the same path", async () => {
  const workspace = createWorkspace(deps);
  await orchestrate(workspace);
  await workspace.sidebarCommand({ kind: "revoke-orchestrator", id: "parent" }, confirm);
  deps.worktrees.launchIdentity = () => Promise.resolve("replaced");
  await expect(make(workspace)).rejects.toThrow("Repository identity changed before re-grant");
});

it("a revoke during resume spawn leaves the new process ordinary and live", async () => {
  const workspace = createWorkspace(deps);
  const initial = { id: "parent", attention: "evaluator" as const, conversationId: "saved-123" };
  launch.mockResolvedValueOnce(initial);
  await orchestrate(workspace);
  await workspace.exited("parent", 0);
  launch.mockImplementationOnce(async (request) => {
    request.beforeSpawn?.();
    await workspace.sidebarCommand({ kind: "revoke-orchestrator", id: "parent" }, confirm);
    return { id: "parent", attention: "evaluator" };
  });
  await workspace.sidebarCommand({ kind: "resume", id: "parent" }, confirm);
  expect(setRole).toHaveBeenLastCalledWith("parent", "agent");
  expect(workspace.orchestration.active(repo.path)).toBeUndefined();
  expect(workspace.snapshot().terminals.find((row) => row.id === "parent")?.exited).toBe(false);
  // An explicit subsequent human grant still succeeds; no resume reservation leaks.
  await make(workspace);
  expect(workspace.orchestration.active(repo.path)).toBe("parent");
});

it("records an exit during resume spawn even when the terminal has a retired parent", async () => {
  const workspace = createWorkspace(deps);
  const initial = { id: "parent", attention: "evaluator" as const, conversationId: "saved-123" };
  launch.mockResolvedValueOnce(initial);
  await orchestrate(workspace);
  await workspace.exited("parent", 0);
  launch.mockImplementationOnce(async (request) => {
    request.beforeSpawn?.();
    await workspace.exited("parent", 1);
    return { id: "parent", attention: "evaluator" };
  });
  await workspace.sidebarCommand({ kind: "resume", id: "parent" }, confirm);
  expect(workspace.snapshot().terminals.find((row) => row.id === "parent")?.exited).toBe(true);
  expect(workspace.orchestration.active(repo.path)).toBeUndefined();
  expect(workspace.orchestration.view("parent")).toMatchObject({ active: false });
  // The dead invocation cannot block another session's grant.
  launch.mockResolvedValueOnce({ id: "second", attention: "evaluator" });
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: child.path, run: "claude" },
    confirm,
  );
  confirm.mockClear();
  await make(workspace, "second");
  expect(confirm.mock.calls.at(-1)?.[0]).not.toHaveProperty("replacing");
  expect(workspace.orchestration.active(repo.path)).toBe("second");
});

it.each([
  ["claude", false, true],
  ["agy", false, false],
  ["claude", true, false],
] as const)(
  "resumes %s ordinarily when MCP=%s and restoreControl=%s",
  async (agent, mcp, restoreControl) => {
    scans.current = {
      ...scan(mcp),
      agents: [
        {
          path: "/bin/fixture",
          version: "1",
          hooks: false,
          reason: "ok",
          id: agent,
          mcp,
          restoreControl,
        },
      ],
    };
    const workspace = createWorkspace(deps);
    const initial = { id: "parent", attention: "evaluator" as const, conversationId: "saved-123" };
    launch.mockResolvedValueOnce(initial);
    await workspace.sidebarCommand(
      { kind: "launch", repository: repo.path, worktree: repo.path, run: agent },
      confirm,
    );
    await make(workspace);
    await workspace.exited("parent", 0);
    launch.mockImplementation((request) => {
      if (request.control)
        return Promise.reject(new Error("This launch cannot restore orchestration without MCP"));
      return Promise.resolve({ id: "parent", attention: "evaluator" });
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await workspace.sidebarCommand({ kind: "resume", id: "parent" }, confirm);
      expect(launch.mock.calls.at(-1)?.[0].control).toBeUndefined();
      expect(workspace.orchestration.active(repo.path)).toBeUndefined();
      await workspace.exited("parent", 0);
    }
  },
);

it("keeps the current orchestrator when transfer back to a former parent has unsettled creation", async () => {
  const workspace = createWorkspace(deps);
  await orchestrate(workspace);
  launch.mockResolvedValueOnce({ id: "second", attention: "evaluator" });
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: child.path, run: "claude" },
    confirm,
  );
  const created = Promise.withResolvers<{ path: string; outcome: "new" }>();
  const entered = Promise.withResolvers<undefined>();
  deps.worktrees.createWorktree = vi.fn(() => {
    entered.resolve(undefined);
    return created.promise;
  });
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const pending = workspace.orchestration.call(
    principal(),
    "create_worktree",
    { branch: "feature", idempotencyKey: "pending-transfer" },
    operations,
  );
  await entered.promise;
  try {
    await make(workspace, "second");
    setRole.mockClear();
    await expect(make(workspace)).rejects.toThrow("conflict");
    expect(workspace.orchestration.active(repo.path)).toBe("second");
    expect(setRole).not.toHaveBeenCalled();
  } finally {
    created.resolve({ path: child.path, outcome: "new" });
    await pending;
  }
});

it("an unrelated retired parent's exit cannot poison a later accepted grant", async () => {
  const workspace = createWorkspace(deps);
  const first = { id: "parent", attention: "evaluator" as const, conversationId: "a-saved" };
  launch.mockResolvedValueOnce(first);
  await orchestrate(workspace);
  const second = { id: "second", attention: "evaluator" as const, conversationId: "d-saved" };
  launch.mockResolvedValueOnce(second);
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: child.path, run: "claude" },
    confirm,
  );
  await make(workspace, "second");
  await workspace.exited("second", 0);
  launch.mockImplementationOnce(async (request) => {
    request.beforeSpawn?.();
    await workspace.exited("parent", 0);
    return { id: "second", attention: "evaluator" };
  });
  await workspace.sidebarCommand({ kind: "resume", id: "second" }, confirm);
  launch.mockResolvedValueOnce({ id: "parent", attention: "evaluator" });
  await workspace.sidebarCommand({ kind: "resume", id: "parent" }, confirm);
  expect(launch.mock.calls.at(-1)?.[0].control).toBeUndefined();
  await make(workspace);
  expect(workspace.orchestration.active(repo.path)).toBe("parent");
});

it("a revoked Resume's early exit cannot retire the next live invocation's accepted grant", async () => {
  const workspace = createWorkspace(deps);
  const initial = { id: "parent", attention: "evaluator" as const, conversationId: "saved-123" };
  launch.mockResolvedValueOnce(initial);
  await orchestrate(workspace);
  await workspace.exited("parent", 0);
  launch.mockImplementationOnce(async (request) => {
    request.beforeSpawn?.();
    await workspace.sidebarCommand({ kind: "revoke-orchestrator", id: "parent" }, confirm);
    await workspace.exited("parent", 1);
    return { id: "parent", attention: "evaluator" };
  });
  await workspace.sidebarCommand({ kind: "resume", id: "parent" }, confirm);
  launch.mockResolvedValueOnce({ id: "parent", attention: "evaluator" });
  await workspace.sidebarCommand({ kind: "resume", id: "parent" }, confirm);
  await make(workspace);
  expect(workspace.orchestration.active(repo.path)).toBe("parent");
});

it("config-origin providers using a built-in ID cannot recover on Resume", async () => {
  const workspace = createWorkspace(deps);
  const initial = {
    id: "parent",
    attention: "evaluator" as const,
    conversationId: "saved",
    providerOrigin: "config" as const,
  };
  launch.mockResolvedValueOnce(initial);
  await orchestrate(workspace);
  await workspace.exited("parent", 0);
  launch.mockResolvedValueOnce({ id: "parent", attention: "evaluator" });
  await workspace.sidebarCommand({ kind: "resume", id: "parent" }, confirm);
  expect(launch.mock.calls.at(-1)?.[0].control).toBeUndefined();
});

it("CLI-only grants do not offer automatic recovery or an exited Revoke item", async () => {
  scans.current = {
    ...scan(false),
    agents: [
      {
        id: "agy",
        path: "/fixture/agy",
        version: "1",
        hooks: false,
        mcp: false,
        restoreControl: false,
        reason: "ok",
      },
    ],
  };
  const workspace = createWorkspace(deps);
  const initial = { id: "parent", attention: "evaluator" as const, conversationId: "saved" };
  launch.mockResolvedValueOnce(initial);
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: repo.path, run: "agy" },
    confirm,
  );
  await make(workspace);
  await workspace.exited("parent", 0);
  expect(workspace.snapshot().terminals[0]?.orchestration).not.toHaveProperty("restoreOnResume");
});

it("a legacy role restored at restart cannot opt into the new Resume disclosure", async () => {
  const { readSessions } = await import("../../../../src/main/workspace/session-store");
  const saved = readSessions([
    {
      id: "parent",
      agent: "claude",
      repository: repo.path,
      worktree: repo.path,
      branch: "main",
      conversationId: "old-saved",
      running: true,
      orchestrator: { identity: "identity", history: [] },
    },
  ]);
  deps.sessions = {
    load: () => Promise.resolve(saved),
    save: () => Promise.resolve(),
    flush: async () => {},
  };
  const workspace = createWorkspace(deps);
  await workspace.restore();
  await workspace.restartSaved();
  expect(workspace.orchestration.active(repo.path)).toBe("parent");
  await workspace.exited("parent", 0);
  launch.mockResolvedValueOnce({ id: "parent", attention: "evaluator" });
  await workspace.sidebarCommand({ kind: "resume", id: "parent" }, confirm);
  expect(launch.mock.calls.at(-1)?.[0].control).toBeUndefined();
  await make(workspace);
  expect(confirm).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: "orchestrator", restoreOnResume: true }),
  );
  await workspace.exited("parent", 0);
  launch.mockResolvedValueOnce({ id: "parent", attention: "evaluator" });
  await workspace.sidebarCommand({ kind: "resume", id: "parent" }, confirm);
  expect(launch.mock.calls.at(-1)?.[0].control).toEqual({ role: "orchestrator" });
});

it("withdrawn provider capabilities hide pending Resume recovery in the menu projection", async () => {
  const changed = vi.fn();
  deps.onChange = changed;
  const workspace = createWorkspace(deps);
  const initial = { id: "parent", attention: "evaluator" as const, conversationId: "saved" };
  launch.mockResolvedValueOnce(initial);
  await orchestrate(workspace);
  await workspace.exited("parent", 0);
  expect(workspace.snapshot().terminals[0]?.orchestration).toHaveProperty("restoreOnResume", true);
  changed.mockClear();
  scans.current = scan(false);
  await workspace.scanAgents(true);
  expect(changed).toHaveBeenCalled();
  expect(workspace.snapshot().terminals[0]?.orchestration).not.toHaveProperty("restoreOnResume");
});

it("a late older scan cannot resurrect an unsupported provider's pending Resume menu", async () => {
  const agents = deps.agents?.(() => Promise.reject(new Error("unused fixture hooks")));
  if (!agents) throw new Error("missing fixture agents");
  const older = Promise.withResolvers<ReturnType<typeof scan>>();
  const newer = Promise.withResolvers<ReturnType<typeof scan>>();
  deps.agents = () => ({
    ...agents,
    scan: vi
      .fn(() => Promise.resolve(scan(true)))
      .mockResolvedValueOnce(scan(true))
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise),
  });
  const workspace = createWorkspace(deps);
  const initial = { id: "parent", attention: "evaluator" as const, conversationId: "saved" };
  launch.mockResolvedValueOnce(initial);
  await orchestrate(workspace);
  await workspace.exited("parent", 0);
  const stale = workspace.scanAgents(true);
  const current = workspace.scanAgents(true);
  newer.resolve(scan(false));
  await current;
  expect(workspace.snapshot().terminals[0]?.orchestration).not.toHaveProperty("restoreOnResume");
  older.resolve(scan(true));
  await stale;
  expect(workspace.snapshot().terminals[0]?.orchestration).not.toHaveProperty("restoreOnResume");
});
