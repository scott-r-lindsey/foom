import { expect, test, vi } from "vitest";
import {
  createWorkspace,
  deps,
  repo,
  main,
  launch,
  confirm,
} from "./orchestration-workspace-fixture";

test("human recovery launches without grants, survives last-row close, and requires reviewed remote deletion", async () => {
  const path = "/foom-remote/unused";
  const tree = { ...main, path, host: "worker", branch: "unused" };
  const placement = {
    host: "worker",
    codeFolder: "/code",
    localRepository: repo.path,
    repository: "/code/repository-clone",
    path: "/code/.foom-worktree-unused",
    branch: "unused",
    identity: "a".repeat(64),
  };
  let present = true;
  const worktree = vi.fn((_host: string, _repository: string, action: { operation: string }) => {
    if (action.operation === "remove-worktree") present = false;
    return Promise.resolve({
      ...placement,
      changes: "",
      sourceOrigin: "git@fixture.test:team/repo.git",
    });
  });
  const hosts = {
    fleet: vi.fn(() => Promise.resolve([])),
    registered: vi.fn(() => ({ host: "worker", codeFolder: "/code" })),
    requireAgent: vi.fn(() => Promise.resolve()),
    placement: (value: string) => (value === path && present ? placement : undefined),
    worktrees: vi.fn(() => Promise.resolve(present ? [tree] : [])),
    worktree,
  };
  const workspace = createWorkspace({ ...deps, hosts });
  expect(await workspace.worktrees(repo.path)).toContainEqual(tree);
  expect(workspace.snapshot().terminals).toEqual([]);
  launch.mockImplementation(() =>
    Promise.resolve({
      id: "human",
      attention: "evaluator",
      remote: true,
      placement: { kind: "remote", host: "worker" },
    }),
  );
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: path, run: "claude" },
    confirm,
  );
  expect(launch.mock.calls[0]?.[0].control).toBeUndefined();
  expect(workspace.snapshot().terminals[0]?.orchestration).toBeUndefined();
  await workspace.exited("human", 0);
  await workspace.sidebarCommand({ kind: "close", id: "human" }, confirm);
  expect(workspace.snapshot().terminals).toEqual([]);
  expect(await workspace.worktrees(repo.path)).toContainEqual(tree);
  const restarted = createWorkspace({ ...deps, hosts });
  expect(await restarted.worktrees(repo.path)).toContainEqual(tree);
  if (!deps.dialog) throw new Error("Missing fixture dialog");
  vi.mocked(deps.dialog).mockResolvedValueOnce(false);
  await restarted.sidebarCommand(
    { kind: "remove-worktree", repository: repo.path, worktree: path },
    confirm,
  );
  expect(present).toBe(true);
  expect(deps.dialog).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Remove remote worktree?",
      subject: "worker:/code/.foom-worktree-unused",
    }),
    expect.any(AbortSignal),
  );
  await restarted.sidebarCommand(
    { kind: "remove-worktree", repository: repo.path, worktree: path },
    confirm,
  );
  expect(present).toBe(false);
  expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
});

test("recovered human shells route the validated remote checkout without local environment or agent probes", async () => {
  const path = "/foom-remote/shell";
  const placement = {
    host: "worker",
    codeFolder: "/code",
    localRepository: repo.path,
    repository: "/code/repository-clone",
    path: "/code/.foom-worktree-shell",
    branch: "unused",
    identity: "a".repeat(64),
  };
  const hosts = {
    fleet: vi.fn(() => Promise.resolve([])),
    registered: vi.fn(() => ({ host: "worker", codeFolder: "/code" })),
    requireAgent: vi.fn(() => Promise.resolve()),
    placement: () => placement,
    worktrees: vi.fn(() => Promise.resolve([{ ...main, path, host: "worker", branch: "unused" }])),
    worktree: vi.fn(() =>
      Promise.resolve({
        ...placement,
        changes: "",
        sourceOrigin: "git@fixture.test:team/repo.git",
      }),
    ),
  };
  const create = vi.fn(() => Promise.resolve("shell"));
  const workspace = createWorkspace({ ...deps, hosts, terminals: { ...deps.terminals, create } });
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: path, run: "shell" },
    confirm,
  );
  expect(hosts.requireAgent).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: placement.path,
      env: {},
      remote: {
        host: "worker",
        checkout: {
          repository: placement.repository,
          path: placement.path,
          identity: placement.identity,
        },
        context: { repository: repo.path, worktree: path, branch: "unused", agent: "shell" },
      },
    }),
  );
  expect(workspace.snapshot().terminals[0]).toMatchObject({
    remote: true,
    placement: { kind: "remote", host: "worker" },
    branch: "unused · worker",
  });
  await expect(
    workspace.sidebarCommand(
      { kind: "remove-worktree", repository: repo.path, worktree: path },
      confirm,
    ),
  ).rejects.toThrow("session is running");
  expect(deps.dialog).not.toHaveBeenCalled();
});
