import { expect, it, vi } from "vitest";
import { Operations } from "../../../../src/main/control/operations";
import type { Operation } from "../../../../src/main/control/types";
import {
  child,
  confirm,
  createWorkspace,
  deps,
  launch,
  orchestrate,
  principal,
} from "./orchestration-workspace-fixture";

it.each([
  "clean",
  "tracked",
  "untracked",
  "changed-head",
  "attached",
  "local-ref",
  "reset-commit",
  "unavailable",
  "declined",
  "second-session",
  "late-change",
  "revoked",
])("review close: %s", async (mode) => {
  const dialog = deps.dialog;
  if (!dialog) throw new Error("Missing fixture dialog");
  const workspace = createWorkspace(deps);
  await orchestrate(workspace);
  const ops = new Operations(
    () => Promise.resolve(),
    () => undefined,
  );
  const actor = principal();
  const tree = (await workspace.orchestration.call(
    actor,
    "create_worktree",
    { branch: "feature", idempotencyKey: "tree" },
    ops,
  )) as Operation;
  launch.mockResolvedValueOnce({ id: "reviewer", attention: "evaluator" });
  await workspace.orchestration.call(
    actor,
    "launch",
    { worktreeId: tree.resultId, agent: "claude", idempotencyKey: "launch" },
    ops,
  );
  await workspace.exited("reviewer", 0);
  vi.mocked(deps.worktrees.reviewIdentity).mockReturnValue("identity");
  vi.mocked(deps.worktrees.canAutoRemoveReview).mockResolvedValue(
    mode === "clean" || mode === "late-change",
  );
  if (mode === "late-change")
    vi.mocked(deps.worktrees.canAutoRemoveReview)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
  if (mode === "tracked") vi.mocked(deps.worktrees.changes).mockResolvedValue(" M tracked\0");
  if (mode === "untracked") vi.mocked(deps.worktrees.changes).mockResolvedValue("?? new\0");
  if (mode === "declined") vi.mocked(dialog).mockResolvedValue(false);
  if (mode === "second-session") {
    launch.mockResolvedValueOnce({ id: "other", attention: "evaluator" });
    await workspace.launch(
      { agent: "claude", repository: actor.repository, worktree: child.path, cols: 80, rows: 24 },
      confirm,
    );
    await workspace.exited("other", 0);
  }
  if (mode === "revoked")
    vi.mocked(dialog).mockImplementationOnce(() => {
      workspace.orchestration.revoke("parent");
      return Promise.resolve(true);
    });
  vi.mocked(dialog).mockClear();
  const result = (await workspace.orchestration.call(
    actor,
    "close",
    { id: "reviewer", idempotencyKey: "close" },
    ops,
  )) as Operation;
  if (mode === "clean") expect(deps.dialog).not.toHaveBeenCalled();
  else
    expect(deps.dialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Remove review worktree?" }),
      expect.any(AbortSignal),
    );
  if (mode === "revoked" || mode === "declined") {
    expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
    expect(workspace.snapshot().terminals.some((row) => row.id === "reviewer")).toBe(true);
    if (mode === "revoked") expect(result.status).toBe("failed");
    else expect(result.status).toBe("declined");
  } else {
    expect(deps.worktrees.removeWorktree).toHaveBeenCalled();
    expect(workspace.snapshot().terminals.some((row) => row.id === "reviewer")).toBe(false);
  }
});

it.each(["takeover", "revocation"])(
  "cancels a pending review-removal confirmation on %s",
  async (mode) => {
    const dialog = deps.dialog;
    if (!dialog) throw new Error("Missing fixture dialog");
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
      { branch: "feature", idempotencyKey: "tree" },
      operations,
    )) as Operation;
    launch.mockResolvedValueOnce({ id: "reviewer", attention: "evaluator" });
    await workspace.orchestration.call(
      actor,
      "launch",
      { worktreeId: tree.resultId, agent: "claude", idempotencyKey: "launch" },
      operations,
    );
    await workspace.exited("reviewer", 0);
    vi.mocked(deps.worktrees.reviewIdentity).mockReturnValue("identity");
    vi.mocked(deps.worktrees.canAutoRemoveReview).mockResolvedValue(false);
    const pendingState: { signal?: AbortSignal } = {};
    vi.mocked(dialog).mockImplementation(
      (_content, signal) =>
        new Promise<boolean>((resolve) => {
          pendingState.signal = signal;
          signal.addEventListener(
            "abort",
            () => {
              resolve(false);
            },
            { once: true },
          );
        }),
    );
    const pending = workspace.orchestration
      .call(actor, "close", { id: "reviewer", idempotencyKey: "close" }, operations)
      .catch(() => undefined);
    await vi.waitFor(() => {
      expect(pendingState.signal).toBeDefined();
    });
    workspace.orchestration.childEvents.publish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pendingState.signal?.aborted).toBe(false);
    if (mode === "takeover") workspace.orchestration.takeOver("reviewer");
    else workspace.orchestration.revoke("parent");
    await pending;
    expect(pendingState.signal?.aborted).toBe(true);
    expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
    expect(workspace.snapshot().terminals.some((row) => row.id === "reviewer")).toBe(true);
  },
);
