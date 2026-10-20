import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { locationId } from "../../../../src/main/control/metadata";

import { harness, history, repo } from "./orchestration-helpers";

describe("worktree removal", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it.each(["OPEN", "CLOSED", "MERGED", undefined] as const)(
    "includes only available cached PR metadata in removal review (%s)",
    async (state) => {
      const h = harness();
      const tree = await h.mutate("create_worktree", { branch: "review" });
      if (state)
        h.host.forge.read.mockReturnValue({
          number: 338,
          state,
          headSha: "a".repeat(40),
          requiredChecks: "success",
        });
      await h.call("remove_worktree", { idempotencyKey: "remove", worktreeId: tree.resultId });
      await vi.waitFor(() => {
        expect(h.host.dialog).toHaveBeenCalledOnce();
      });
      expect(h.host.dialog.mock.calls[0]?.[0].removal?.item.pullRequest).toEqual(
        state ? { number: 338, state } : undefined,
      );
      expect(h.host.forge.read).toHaveBeenCalledWith(repo, join(repo, "trees", "review"));
    },
  );

  it("always asks the human, even for a clean worktree, and keeps the branch", async () => {
    const h = harness();
    const tree = await h.mutate("create_worktree", { branch: "done" });
    const pending = await h.call("remove_worktree", {
      idempotencyKey: "remove",
      worktreeId: tree.resultId,
    });
    expect(pending).toMatchObject({ status: "pending_confirmation", action: "remove_worktree" });
    await vi.waitFor(async () => {
      expect(await h.call("operation_status", { idempotencyKey: "remove" })).toMatchObject({
        status: "succeeded",
        resultId: tree.resultId,
      });
    });
    expect(h.host.dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Remove worktrees?",
        removal: expect.objectContaining({
          item: expect.objectContaining({ branch: "feature", changes: "" }) as unknown,
        }) as unknown,
        accept: "Approve all",
      }),
      expect.any(AbortSignal),
    );

    // The removed worktree no longer belongs to the orchestrator.
    await expect(
      h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" }),
    ).rejects.toThrow("not_found");
  });

  it("records a declined removal and shows changed files in the dialog", async () => {
    const h = harness();
    const tree = await h.mutate("create_worktree", { branch: "dirty" });
    h.host.dialog.mockResolvedValueOnce(false);
    h.host.remove.mockImplementationOnce((_repository, _worktree, _identity, confirm) =>
      confirm("dirty", " M file\0"),
    );
    await h.call("remove_worktree", { idempotencyKey: "r", worktreeId: tree.resultId });
    await vi.waitFor(async () => {
      expect(await h.call("operation_status", { idempotencyKey: "r" })).toMatchObject({
        status: "declined",
        reason: "refused",
      });
    });
    expect(h.host.dialog.mock.calls[0]?.[0]).toMatchObject({
      removal: { item: { changes: " M file\0" } },
    });
  });

  it("cancels a pending confirmation when the parent exits, even if the dialog later accepts", async () => {
    const h = harness();
    const tree = await h.mutate("create_worktree", { branch: "stale" });
    let answer: (value: boolean) => void = () => undefined;
    let signal: AbortSignal | undefined;
    h.host.dialog.mockImplementationOnce((_content, abort) => {
      signal = abort;
      return new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    });
    let removed = false;
    h.host.remove.mockImplementationOnce(async (_repository, _worktree, _identity, confirm) => {
      removed = await confirm("stale", "");
      return removed;
    });
    await h.call("remove_worktree", { idempotencyKey: "r", worktreeId: tree.resultId });
    await vi.waitFor(() => {
      expect(signal).toBeDefined();
    });
    h.exit("parent");
    expect(signal?.aborted).toBe(true);
    h.grant.dispose();
    answer(true);
    await settle();
    await settle();
    expect(removed).toBe(false);
    const entries = history(h.orchestration.view("parent"));
    expect(entries.at(-1)?.status).toBe("cancelled");
  });

  it("marks a failure after acceptance and refuses foreign or occupied worktrees", async () => {
    const h = harness();
    const tree = await h.mutate("create_worktree", { branch: "racy" });
    h.host.remove.mockImplementationOnce(async (_repository, _worktree, _identity, confirm) => {
      await confirm("racy", "");
      throw new Error("Worktree changes have changed");
    });
    await h.call("remove_worktree", { idempotencyKey: "r", worktreeId: tree.resultId });
    await vi.waitFor(async () => {
      expect(await h.call("operation_status", { idempotencyKey: "r" })).toMatchObject({
        status: "failed",
      });
    });
    await expect(h.mutate("remove_worktree", { worktreeId: locationId(repo) })).rejects.toThrow(
      "not_found",
    );
    const { worktreeId } = await h.child("busy");
    await expect(h.mutate("remove_worktree", { worktreeId })).rejects.toThrow("conflict");
    expect(h.host.dialog).toHaveBeenCalledTimes(1);
  });

  it("records an indeterminate outcome when the parent exits after the human accepted", async () => {
    const h = harness();
    const tree = await h.mutate("create_worktree", { branch: "late" });
    h.host.remove.mockImplementationOnce(async (_repository, _worktree, _identity, confirm) => {
      await confirm("late", "");
      h.exit("parent");
      h.grant.dispose();
      throw new Error("interrupted");
    });
    await h.call("remove_worktree", { idempotencyKey: "r", worktreeId: tree.resultId });
    await vi.waitFor(() => {
      const entries = history(h.orchestration.view("parent"));
      expect(entries.at(-1)?.status).toBe("indeterminate");
    });
  });
});
