import { expect, it, vi } from "vitest";
import { Operations } from "../../../../src/main/control/operations";
import type { Operation } from "../../../../src/main/control/types";
import {
  repo,
  child,
  deps,
  launch,
  stop,
  tail,
  confirm,
  orchestrate,
  principal,
  createWorkspace,
} from "./orchestration-workspace-fixture";

it.each([
  ["claude", ["--dangerously-skip-permissions"]],
  ["codex", ["-c", 'sandbox_mode="danger-full-access"']],
] as const)(
  "refuses %s children whose defaults bypass permissions before spawning",
  async (agent, args) => {
    const workspace = createWorkspace(deps);
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
    const workspace = createWorkspace(deps);
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
      {
        idempotencyKey: "b",
        worktreeId: tree.resultId,
        agent: "claude",
        prompt: "Write tests",
        ...(showNewChildren ? { model: "child-model", effort: "low" } : {}),
      },
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
    if (showNewChildren)
      expect(launch.mock.calls.at(-1)?.[0].selection).toEqual({
        model: "child-model",
        effort: "low",
      });
    const row = workspace.snapshot().terminals.find((entry) => entry.id === "child");
    if (showNewChildren) expect(row?.selection).toEqual({ model: "child-model", effort: "low" });
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

it("refuses to launch a child into the main checkout or an unavailable worktree", async () => {
  const workspace = createWorkspace(deps);
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
  const workspace = createWorkspace(deps);
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

it("reports a creation error as indeterminate when git may have added the checkout", async () => {
  const workspace = createWorkspace(deps);
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
  const workspace = createWorkspace(deps);
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

it("closes an exited child through the normal session removal path", async () => {
  const kill = vi.spyOn(deps.terminals, "kill");
  const forget = vi.spyOn(deps.verdicts, "forget");
  const workspace = createWorkspace(deps);
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
