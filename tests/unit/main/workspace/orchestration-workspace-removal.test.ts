import { expect, it, vi } from "vitest";
import type { WorkspaceDependencies } from "../../../../src/main/workspace/workspace-types";
import { Operations } from "../../../../src/main/control/operations";
import type { Operation } from "../../../../src/main/control/types";
import type { RemovalFeed } from "../../../../src/shared/confirmation";
import {
  repo,
  main,
  child,
  deps,
  stop,
  confirm,
  orchestrate,
  principal,
  createWorkspace,
} from "./orchestration-workspace-fixture";

it("removes an orchestrator worktree only through the trusted dialog", async () => {
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
  const fallback = createWorkspace(deps);
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
  const workspace = createWorkspace(deps);
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
    const workspace = createWorkspace(deps);
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

it("rechecks running sessions under the removal lock", async () => {
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
    const workspace = createWorkspace(deps);
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
      ).toEqual([
        "completed",
        mode === "failure"
          ? "git_failed"
          : mode === "identity"
            ? "identity_changed"
            : "changes_changed",
        "completed",
      ]);
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
    const workspace = createWorkspace(deps);
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
    const workspace = createWorkspace(deps);
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

it.each([false, true])(
  "reviews untracked-only detached evidence (approved: %s)",
  async (approved) => {
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
      { idempotencyKey: "evidence", branch: "review" },
      operations,
    )) as Operation;
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([main, { ...child, branch: null }]);
    vi.mocked(deps.worktrees.changes).mockResolvedValue("?? screenshots/review.png\0");
    deps.dialog = vi.fn(() => Promise.resolve(approved));
    await workspace.orchestration.call(
      actor,
      "remove_worktree",
      { idempotencyKey: "remove-evidence", worktreeId: tree.resultId },
      operations,
    );
    await vi.waitFor(() => {
      expect(operations.lookup(actor, { idempotencyKey: "remove-evidence" })).toMatchObject({
        status: approved ? "succeeded" : "declined",
        reason: approved ? "completed" : "untracked_files",
      });
    });
    expect(deps.dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        removal: expect.objectContaining({
          item: expect.objectContaining({ changes: "?? screenshots/review.png\0" }) as unknown,
        }) as unknown,
      }),
      expect.any(AbortSignal),
    );
    if (approved)
      expect(deps.worktrees.removeWorktree).toHaveBeenCalledWith(
        repo.path,
        child.path,
        true,
        "identity",
        expect.any(Function),
      );
    else expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
  },
);
