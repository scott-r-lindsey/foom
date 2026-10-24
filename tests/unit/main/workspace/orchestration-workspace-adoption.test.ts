import { expect, it, vi } from "vitest";
import { Operations } from "../../../../src/main/control/operations";
import {
  repo,
  child,
  deps,
  launch,
  orchestrate,
  principal,
  createWorkspace,
} from "./orchestration-workspace-fixture";

it("adopts under repository and branch locks, then releases them on completion", async () => {
  const workspace = createWorkspace(deps);
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
  const workspace = createWorkspace(deps);
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
  const workspace = createWorkspace(deps);
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
  const workspace = createWorkspace(deps);
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
