import { expect, it } from "vitest";
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
