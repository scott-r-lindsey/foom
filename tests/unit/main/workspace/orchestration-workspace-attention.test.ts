import { expect, it, vi } from "vitest";
import type { WorkspaceDependencies } from "../../../../src/main/workspace/workspace-types";
import { Operations } from "../../../../src/main/control/operations";
import type { Operation } from "../../../../src/main/control/types";
import {
  deps,
  launch,
  tail,
  orchestrate,
  principal,
  createWorkspace,
} from "./orchestration-workspace-fixture";

it("projects unread child attention and clears on human focus without changing execution", async () => {
  let time = 1000;
  deps.now = () => time;
  const workspace = createWorkspace(deps);
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
  const workspace = createWorkspace(deps);
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
