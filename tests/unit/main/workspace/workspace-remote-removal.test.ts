import { MessageBoard } from "../../../../src/main/control/message-board";
import { locationId } from "../../../../src/main/control/metadata";
import { expect, test, vi } from "vitest";
import { UncertainEffect } from "../../../../src/main/workspace/worktree-outcome";
import {
  createWorkspace,
  deps,
  repo,
  main,
  launch,
  confirm,
} from "./orchestration-workspace-fixture";

test.each(["success", "cancel", "uncertain"])(
  "recovered remote deletion releases exited rows only on success (%s)",
  async (outcome) => {
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
    const hosts = {
      fleet: vi.fn(() => Promise.resolve([])),
      registered: vi.fn(() => ({ host: "worker", codeFolder: "/code" })),
      requireAgent: vi.fn(() => Promise.resolve()),
      placement: () => (present ? placement : undefined),
      worktrees: vi.fn(() => Promise.resolve(present ? [tree] : [])),
      worktree: vi.fn((_host: string, _repo: string, action: { operation: string }) => {
        if (action.operation === "remove-worktree") {
          present = false;
          if (outcome === "uncertain") return Promise.reject(new Error("lost reply"));
        }
        return Promise.resolve({
          ...placement,
          changes: "",
          sourceOrigin: "git@fixture.test:team/repo.git",
        });
      }),
    };
    const kill = vi.fn(() => Promise.resolve());
    const workspace = createWorkspace({ ...deps, hosts, terminals: { ...deps.terminals, kill } });
    const board = new MessageBoard(
      async () => {},
      () => [{ id: locationId(repo.path), name: "Repo" }],
    );
    workspace.orchestration.setBoard(board);
    await board.childEvent(
      locationId(repo.path),
      { id: "closed-child", worktreeId: locationId(path) },
      "unused",
      "launch",
      { prompt: "Task" },
      "launch",
    );
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
    await workspace.exited("human", 0);
    expect(workspace.snapshot().terminals).toHaveLength(1);
    if (outcome === "cancel") {
      if (!deps.dialog) throw new Error("Missing fixture dialog");
      vi.mocked(deps.dialog).mockResolvedValueOnce(false);
    }
    const removal = workspace.sidebarCommand(
      { kind: "remove-worktree", repository: repo.path, worktree: path },
      confirm,
    );
    if (outcome === "uncertain") await expect(removal).rejects.toBeInstanceOf(UncertainEffect);
    else await removal;
    expect(present).toBe(outcome === "cancel");
    expect(
      hosts.worktree.mock.calls.filter(([, , action]) => action.operation === "remove-worktree"),
    ).toHaveLength(outcome === "cancel" ? 0 : 1);
    expect(workspace.snapshot().terminals).toHaveLength(outcome === "success" ? 0 : 1);
    await board.flushChildren();
    expect(board.childThreads()[0]?.child?.removedAt !== undefined).toBe(outcome === "success");
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 86400000);
    try {
      await board.prune();
      expect(board.childThreads()).toHaveLength(outcome === "success" ? 0 : 1);
    } finally {
      now.mockRestore();
    }
    if (outcome === "success") expect(kill).toHaveBeenCalledWith("human", "worker");
    else expect(kill).not.toHaveBeenCalled();
  },
);

test("control: local worktree deletion releases its exited session rows", async () => {
  const { child } = await import("./orchestration-workspace-fixture");
  const workspace = createWorkspace(deps);
  launch.mockResolvedValue({ id: "human", attention: "evaluator" });
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: child.path, run: "claude" },
    confirm,
  );
  await workspace.exited("human", 0);
  expect(workspace.snapshot().terminals).toHaveLength(1);
  await workspace.sidebarCommand(
    { kind: "remove-worktree", repository: repo.path, worktree: child.path },
    confirm,
  );
  expect(workspace.snapshot().terminals).toEqual([]);
});
