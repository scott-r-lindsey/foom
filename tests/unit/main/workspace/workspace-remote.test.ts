import { afterEach, expect, test } from "vitest";
import { Operations } from "../../../../src/main/control/operations";
import { object } from "../../../../src/shared/control-validation";
import {
  repo,
  child,
  deps,
  launch,
  orchestrate,
  principal,
  createWorkspace,
} from "./orchestration-workspace-fixture";
const argv = [...process.argv];
afterEach(() => process.argv.splice(0, process.argv.length, ...argv));
test("human remote resume retains only its live owning parent and rechecks ownership immediately before spawn", async () => {
  const workspace = createWorkspace(deps);
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const tree = object(
    await workspace.orchestration.call(
      principal(),
      "create_worktree",
      { idempotencyKey: "remote-tree", branch: "feature" },
      operations,
    ),
  );
  launch.mockImplementationOnce(() =>
    Promise.resolve({
      id: "remote",
      attention: "evaluator" as const,
      remote: true as const,
      conversationId: "saved-conversation",
    }),
  );
  await workspace.orchestration.call(
    principal(),
    "launch",
    { idempotencyKey: "remote-child", worktreeId: tree["resultId"], agent: "claude" },
    operations,
  );
  await workspace.exited("remote", 0);
  process.argv.push(
    "--remote-agent-spike=fixture",
    "--remote-agent-artifact=/tmp/host",
    `--remote-agent-local-checkout=${child.path}`,
    "--remote-agent-repository=/remote/repo",
    "--remote-agent-worktree=/remote/tree",
  );
  launch.mockImplementationOnce((request) => {
    request.beforeSpawn?.();
    return Promise.resolve({
      id: "remote",
      attention: "evaluator" as const,
      remote: true as const,
      conversationId: "saved-conversation",
    });
  });
  await workspace.sidebarCommand({ kind: "resume", id: "remote" }, () => Promise.resolve(true));
  expect(launch.mock.calls.at(-1)?.[0]).toMatchObject({
    repository: repo.path,
    worktree: child.path,
    control: { parentId: "parent" },
    conversationId: "saved-conversation",
  });
  expect(workspace.orchestration.view("remote")).toMatchObject({
    role: "child",
    parentId: "parent",
    takenOver: false,
  });
  await workspace.exited("remote", 0);
  launch.mockImplementationOnce((request) => {
    workspace.orchestration.takeOver("remote");
    request.beforeSpawn?.();
    return Promise.resolve({ id: "remote", attention: "evaluator" as const });
  });
  await expect(
    workspace.sidebarCommand({ kind: "resume", id: "remote" }, () => Promise.resolve(true)),
  ).rejects.toThrow("ownership changed");
  expect(workspace.snapshot().terminals.find((entry) => entry.id === "remote")?.exited).toBe(true);
  await expect(
    workspace.sidebarCommand({ kind: "resume", id: "remote" }, () => Promise.resolve(true)),
  ).rejects.toThrow("owned child");
});

test("remote review launch refuses before local reviewer discovery or spawning and leaves ordinary launch available", async () => {
  const workspace = createWorkspace(deps);
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const actor = principal();
  const tree = object(
    await workspace.orchestration.call(
      actor,
      "create_worktree",
      {
        idempotencyKey: "review-tree",
        branch: "feature",
      },
      operations,
    ),
  );
  process.argv.push(
    "--remote-agent-spike=fixture",
    "--remote-agent-artifact=/tmp/host",
    `--remote-agent-local-checkout=${child.path}`,
    "--remote-agent-repository=/remote/repo",
    "--remote-agent-worktree=/remote/tree",
  );
  const before = launch.mock.calls.length;
  await expect(
    workspace.orchestration.call(
      actor,
      "launch",
      {
        idempotencyKey: "remote-review",
        worktreeId: tree["resultId"],
        agent: "claude",
        review: { rounds: 1, agent: "codex" },
      },
      operations,
    ),
  ).rejects.toMatchObject({ code: "remote_review_unsupported" });
  expect(launch.mock.calls).toHaveLength(before);
  launch.mockResolvedValueOnce({ id: "ordinary", attention: "evaluator" });
  expect(
    await workspace.orchestration.call(
      actor,
      "launch",
      {
        idempotencyKey: "ordinary",
        worktreeId: tree["resultId"],
        agent: "claude",
      },
      operations,
    ),
  ).toMatchObject({ status: "succeeded", resultId: "ordinary" });
});
