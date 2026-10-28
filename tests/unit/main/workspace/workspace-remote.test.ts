import { afterEach, expect, test, vi } from "vitest";
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

test("closing a dormant remote row uses its saved host, retains unreachable failures, and retries cleanup", async () => {
  const { readSessions } = await import("../../../../src/main/workspace/session-store");
  const stored = readSessions([
    {
      id: "remote",
      agent: "claude",
      repository: repo.path,
      worktree: child.path,
      branch: "feature",
      remote: true,
      placement: { kind: "remote", host: "original-host" },
    },
  ]);
  const save = vi.fn(async () => {});
  const kill = vi.fn<(id: string, host?: string) => Promise<void>>(() => Promise.resolve());
  const workspace = createWorkspace({
    ...deps,
    terminals: { ...deps.terminals, kill },
    sessions: { load: () => Promise.resolve(stored), save, flush: async () => {} },
  });
  await workspace.restore();
  kill.mockRejectedValueOnce(new Error("private stderr"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(
    workspace.sidebarCommand({ kind: "close", id: "remote" }, () => Promise.resolve(true)),
  ).rejects.toMatchObject({ reason: "remote_host_unreachable" });
  expect(workspace.snapshot().terminals.find((row) => row.id === "remote")).toMatchObject({
    remote: true,
    remoteCleanup: "unreachable",
  });
  expect(log).toHaveBeenCalledWith("Remote child close failed: remote_host_unreachable");
  await workspace.sidebarCommand({ kind: "close", id: "remote" }, () => Promise.resolve(true));
  expect(kill).toHaveBeenCalledWith("remote", "original-host");
  expect(workspace.snapshot().terminals.find((row) => row.id === "remote")).toBeUndefined();
});

test("registered remote children have sidebar checkout rows without a local shadow and resume on their captured host", async () => {
  const remote = {
    repository: "/code/repository-fixture",
    path: "/code/.foom-worktree-fixture",
    branch: "feature",
    identity: "a".repeat(64),
    changes: "",
  };
  const hosts = {
    registered: vi.fn(() => ({ host: "worker", codeFolder: "/code" })),
    worktree: vi.fn(() => Promise.resolve({ ...remote })),
    requireAgent: vi.fn(() => Promise.resolve()),
    fleet: vi.fn(() => Promise.resolve([])),
  };
  const workspace = createWorkspace({ ...deps, hosts });
  await orchestrate(workspace);
  const operations = new Operations(
    () => Promise.resolve(),
    () => {},
  );
  const tree = object(
    await workspace.orchestration.call(
      principal(),
      "create_worktree",
      { host: "worker", branch: "feature", idempotencyKey: "fleet-tree" },
      operations,
    ),
  );
  launch.mockImplementation(async (request) => {
    await request.remoteCheckout?.validate();
    request.beforeSpawn?.();
    return {
      id: "remote-registered",
      attention: "evaluator",
      remote: true,
      placement: { kind: "remote", host: "worker" },
      conversationId: "saved",
    };
  });
  const started = object(
    await workspace.orchestration.call(
      principal(),
      "launch",
      { worktreeId: tree["resultId"], agent: "codex", idempotencyKey: "fleet-child" },
      operations,
    ),
  );
  expect(started["status"]).toBe("succeeded");
  expect(deps.worktrees.createWorktree).not.toHaveBeenCalled();
  const row = workspace.snapshot().terminals.find((row) => row.id === "remote-registered");
  expect(row).toMatchObject({
    placement: { kind: "remote", host: "worker" },
    branch: "feature · worker",
  });
  const inventory = await workspace.sidebarInventory();
  expect(inventory.repositories[0]?.worktrees).toContainEqual(
    expect.objectContaining({ path: row?.worktree, branch: "feature · worker" }),
  );
  expect(await workspace.worktrees(repo.path)).toContainEqual(
    expect.objectContaining({ path: row?.worktree }),
  );
  await workspace.exited("remote-registered", 0);
  remote.branch = "HEAD";
  await workspace.sidebarCommand({ kind: "resume", id: "remote-registered" }, () =>
    Promise.resolve(true),
  );
  expect(launch.mock.calls.at(-1)?.[0]).toMatchObject({
    terminalId: "remote-registered",
    remoteCheckout: { target: { host: "worker" }, worktree: remote.path },
  });
  expect(workspace.snapshot().terminals.find((row) => row.id === "remote-registered")?.branch).toBe(
    "Detached HEAD · worker",
  );
  await workspace.exited("remote-registered", 0);
  const probe = Promise.withResolvers<undefined>();
  hosts.requireAgent.mockClear().mockReturnValueOnce(probe.promise);
  const resuming = workspace.sidebarCommand({ kind: "resume", id: "remote-registered" }, () =>
    Promise.resolve(true),
  );
  await vi.waitFor(() => {
    expect(hosts.requireAgent).toHaveBeenCalledOnce();
  });
  const removal = object(
    await workspace.orchestration.call(
      principal(),
      "remove_worktree",
      { worktreeId: tree["resultId"], idempotencyKey: "remove-during-resume" },
      operations,
    ),
  );
  await vi.waitFor(() => {
    expect(operations.lookup(principal(), { operationId: removal["operationId"] })).toMatchObject({
      status: "failed",
      reason: "busy",
    });
  });
  probe.resolve(undefined);
  await resuming;
});
