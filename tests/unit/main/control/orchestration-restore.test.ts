import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { locationId } from "../../../../src/main/control/metadata";
import { Orchestration } from "../../../../src/main/control/orchestration";
import { LaunchFailure } from "../../../../src/shared/launch-failure";
import type { WorkspaceTerminal } from "../../../../src/shared/workspace";

import { harness, other, repo } from "./orchestration-helpers";

it("keeps archived reviewer handoffs and continuation settings when restoring an author row in the same worktree", async () => {
  const h = harness();
  const path = join(repo, "trees", "continue");
  const saved = {
    path,
    identity: "id-continue",
    state: "used" as const,
    reviewer: true as const,
    pullRequest: 7,
    review: { rounds: 2, agent: "claude", postFindings: false },
    closedReviews: [
      {
        id: "closed-reviewer",
        handoffs: [
          {
            seq: 1,
            status: "done" as const,
            summary: "Retained result",
            links: [],
            timestamp: new Date(0).toISOString(),
            review: { verdict: "clean" as const },
          },
        ],
      },
    ],
  };
  try {
    await h.orchestration.restoreWorktrees("parent", [saved]);
    expect(await h.call("read_handoff", { id: "closed-reviewer" })).toMatchObject({
      summary: "Retained result",
    });
    const parent = h.rows.get("parent");
    if (!parent) throw new Error("missing parent");
    expect(
      await h.orchestration.restoreChild("parent", {
        ...parent,
        id: "restored-author",
        worktree: path,
        branch: "continue",
        exited: true,
      }),
    ).toBe(true);
    expect(await h.call("read_handoff", { id: "closed-reviewer" })).toMatchObject({
      summary: "Retained result",
    });
    expect(h.orchestration.ownedWorktrees("parent")).toEqual([saved]);
  } finally {
    h.orchestration.disposeUnreadChildren();
  }
});

it("rejects stop while a restored child is queued instead of claiming it stopped", async () => {
  const fixture = harness();
  const starting = vi.fn(() => true);
  const orchestration = new Orchestration({ ...fixture.host, starting });
  const slot = orchestration.reserve(repo);
  if ("existing" in slot) throw new Error("unexpected parent");
  slot.bind("parent");
  const row: WorkspaceTerminal = {
    id: "queued",
    kind: "agent",
    agent: "claude",
    repository: repo,
    worktree: join(repo, "child"),
    branch: "child",
    attention: "evaluator",
    state: null,
  };
  expect(await orchestration.restoreChild("parent", row)).toBe(true);
  await expect(
    orchestration.call(
      fixture.actor,
      "stop",
      { id: row.id, idempotencyKey: "queued-stop" },
      fixture.operations,
    ),
  ).rejects.toThrow();
  expect(fixture.host.stop).not.toHaveBeenCalled();
  starting.mockReturnValue(false);
  await orchestration.call(
    fixture.actor,
    "stop",
    { id: row.id, idempotencyKey: "ready-stop" },
    fixture.operations,
  );
  expect(fixture.host.stop).toHaveBeenCalledWith(row.id);
});

it("restores unused ownership for launch and used ownership for confirmed removal", async () => {
  const h = harness();
  const path = join(repo, "trees", "saved");
  await h.orchestration.restoreWorktrees("missing", []);
  await h.orchestration.restoreWorktrees("parent", [
    { path, identity: "id-saved", state: "unused" },
  ]);
  expect(h.orchestration.ownedWorktrees("missing")).toEqual([]);
  expect(h.orchestration.uncertainWorktrees("missing")).toBe(0);
  expect(h.orchestration.ownedWorktrees("parent")).toEqual([
    { path, identity: "id-saved", state: "unused" },
  ]);
  const launched = await h.mutate("launch", { worktreeId: locationId(path), agent: "claude" });
  expect(launched.status).toBe("succeeded");
  h.exit(launched.resultId ?? "");
  await expect(
    h.mutate("launch", { worktreeId: locationId(path), agent: "claude" }),
  ).rejects.toThrow("conflict");
  expect((await h.mutate("remove_worktree", { worktreeId: locationId(path) })).status).toBe(
    "pending_confirmation",
  );
  await vi.waitFor(() => {
    expect(h.host.remove).toHaveBeenCalled();
  });
});

it("restores legacy exited children as used without consuming the live child budget", async () => {
  const h = harness();
  for (let i = 0; i < 6; i++) {
    expect(
      await h.orchestration.restoreChild("parent", {
        ...h.rows.get("parent"),
        id: `old-${String(i)}`,
        kind: "agent",
        agent: "claude",
        repository: repo,
        worktree: join(repo, "trees", String(i)),
        branch: "untrusted",
        attention: "evaluator",
        state: null,
        exited: true,
      }),
    ).toBe(true);
  }
  expect(h.orchestration.ownedWorktrees("parent")).toHaveLength(6);
  expect(h.orchestration.ownedWorktrees("parent").every((tree) => tree.state === "used")).toBe(
    true,
  );
  for (let i = 0; i < 4; i++) await h.child(`live-${String(i)}`);
  const row = h.rows.get("parent");
  if (!row) throw new Error("missing row");
  expect(
    await h.orchestration.restoreChild("parent", {
      ...row,
      id: "overflow",
      worktree: join(repo, "extra"),
    }),
  ).toBe(false);
  expect(await h.orchestration.restoreChild("missing", row)).toBe(false);
  expect(
    await h.orchestration.restoreChild("parent", { ...row, id: "foreign", repository: other }),
  ).toBe(false);
});

it("keeps restore within the unused budget and refuses missing or changed identities", async () => {
  const h = harness();
  const trees = Array.from({ length: 5 }, (_, i) => ({
    path: join(repo, String(i)),
    identity: `id-${String(i)}`,
    state: "unused" as const,
  }));
  await h.orchestration.restoreWorktrees("parent", trees, 1);
  expect(h.orchestration.ownedWorktrees("parent")).toHaveLength(3);
  expect(h.orchestration.uncertainWorktrees("parent")).toBe(1);
  await expect(h.mutate("create_worktree", { branch: "overflow" })).rejects.toThrow("capacity");
  await h.orchestration.restoreWorktrees("parent", [
    trees[0] ?? { path: repo, identity: "bad", state: "used" },
  ]);
  await h.orchestration.restoreWorktrees("parent", [
    { path: join(repo, "changed"), identity: "old", state: "used" },
  ]);
  h.host.restoreWorktree.mockRejectedValue(new Error("missing"));
  const row = h.rows.get("parent");
  if (!row) throw new Error("missing row");
  expect(await h.orchestration.restoreChild("parent", { ...row, id: "missing" })).toBe(false);
  await h.orchestration.restoreWorktrees("parent", [
    { path: join(repo, "missing"), identity: "old", state: "used" },
  ]);
  expect(h.orchestration.ownedWorktrees("parent")).toHaveLength(3);
});

it.each([1, 2, 5, 16])("reserves exactly %i children with the current setting", async (limit) => {
  const h = harness();
  h.setLimit(limit);
  for (let i = 0; i < limit; i++) await h.child(`child-${String(i)}`);
  const tree = await h.mutate("create_worktree", { branch: "extra" });
  await expect(h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" })).rejects.toThrow(
    "capacity",
  );
  expect(h.host.launch).toHaveBeenCalledTimes(limit);
  const ids = [...h.rows.keys()].filter((id) => id !== "parent");
  expect(await h.call("wait_for", { ids })).toMatchObject({ sessions: ids.map((id) => ({ id })) });
  await expect(h.call("wait_for", { ids: [...ids, "extra"] })).rejects.toThrow("invalid_request");
});

it("lowering mid-run leaves children alive and blocks until below the new limit", async () => {
  const h = harness();
  h.setLimit(3);
  const first = (await h.child("a")).id;
  const second = (await h.child("b")).id;
  await h.child("c");
  h.setLimit(2);
  expect(h.host.stop).not.toHaveBeenCalled();
  expect(h.orchestration.view("parent")).toMatchObject({ children: 3 });
  const tree = await h.mutate("create_worktree", { branch: "d" });
  const launch = () => h.mutate("launch", { worktreeId: tree.resultId, agent: "claude" });
  await expect(launch()).rejects.toThrow("capacity");
  await h.mutate("stop", { id: first });
  await expect(launch()).rejects.toThrow("capacity");
  h.exit(first);
  await expect(launch()).rejects.toThrow("capacity");
  h.exit(second);
  expect(await launch()).toMatchObject({ status: "succeeded" });
  h.setLimit(3);
  expect(await h.child("e")).toHaveProperty("id");
});

it("counts starting reservations at a changed limit", async () => {
  const h = harness();
  h.setLimit(1);
  const a = await h.mutate("create_worktree", { branch: "a" });
  const b = await h.mutate("create_worktree", { branch: "b" });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = h.host.launch.getMockImplementation();
  h.host.launch.mockImplementation(async (...args) => {
    await gate;
    return original?.(...args) ?? "";
  });
  const pending = h.mutate("launch", { worktreeId: a.resultId, agent: "claude" });
  await vi.waitFor(() => {
    expect(h.host.launch).toHaveBeenCalledOnce();
  });
  await expect(h.mutate("launch", { worktreeId: b.resultId, agent: "claude" })).rejects.toThrow(
    "capacity",
  );
  release();
  expect(await pending).toMatchObject({ status: "succeeded" });
});

it("keeps a timed-out owned worktree's identity for a later check without granting ownership", async () => {
  const h = harness();
  const worktree = join(repo, "trees", "child");
  const saved = { path: worktree, identity: "old-identity", state: "used" as const };
  const parent = h.rows.get("parent");
  if (!parent) throw new Error("missing parent");
  const child = { ...parent, id: "unverified", worktree, exited: true };
  h.host.restoreWorktree.mockRejectedValueOnce(new LaunchFailure("remote_host_unreachable"));
  await h.orchestration.restoreWorktrees("parent", [saved]);
  h.rows.set(child.id, child);
  const result = await h.orchestration.restoreChild("parent", child);
  if (typeof result === "boolean") throw new Error("expected an unproven child link");
  expect(result.parentStillActive()).toBe(true);
  expect(h.host.restoreWorktree).toHaveBeenCalledOnce();
  expect(h.orchestration.view(child.id)).toBeUndefined();
  expect(h.orchestration.ownedWorktrees("parent")).toEqual([]);
  expect(h.host.forge.track).not.toHaveBeenCalled();
  await expect(h.call("read_handoff", { id: child.id })).rejects.toThrow();
  const retry = harness();
  const savedWorktrees = h.orchestration.savedWorktrees("parent");
  expect(savedWorktrees).toEqual([saved]);
  await retry.orchestration.restoreWorktrees("parent", savedWorktrees);
  // The new tree at the same path still has to match the original identity.
  expect(await retry.orchestration.restoreChild("parent", child)).toBe(false);
  expect(retry.orchestration.savedWorktrees("parent")).toEqual([]);
});

it("drops a child proof if a human claims the row or replaces the parent during the check", async () => {
  const h = harness();
  const parent = h.rows.get("parent");
  if (!parent) throw new Error("missing parent");
  const child = { ...parent, id: "checking", worktree: join(repo, "trees", "child"), exited: true };
  const proof = { branch: "child", identity: "child-tree" };
  const pending = Promise.withResolvers<typeof proof>();
  h.host.restoreWorktree.mockReturnValueOnce(pending.promise);
  let eligible = true;
  const checking = h.orchestration.restoreChild("parent", child, () => eligible);
  eligible = false;
  pending.resolve(proof);
  await expect(checking).resolves.toBe(false);

  const next = Promise.withResolvers<typeof proof>();
  h.host.restoreWorktree.mockReturnValueOnce(next.promise);
  const replacing = h.orchestration.restoreChild("parent", child);
  h.exit("parent");
  h.launchParent("parent");
  next.resolve(proof);
  await expect(replacing).resolves.toBe(false);
  expect(h.orchestration.view(child.id)).toBeUndefined();
  expect(h.orchestration.ownedWorktrees("parent")).toEqual([]);
});

it("preserves an unavailable legacy child link only for the same active parent", async () => {
  const h = harness();
  const parent = h.rows.get("parent");
  if (!parent) throw new Error("missing parent");
  h.host.restoreWorktree.mockRejectedValueOnce(new LaunchFailure("timed-out"));
  const result = await h.orchestration.restoreChild("parent", {
    ...parent,
    id: "legacy",
    worktree: join(repo, "legacy"),
    exited: true,
  });
  if (typeof result === "boolean") throw new Error("expected an unproven child link");
  expect(result.parentStillActive()).toBe(true);
  h.exit("parent");
  h.launchParent("parent");
  expect(result.parentStillActive()).toBe(false);
  expect(h.orchestration.view("legacy")).toBeUndefined();
});

it.each(["create", "adopt"] as const)(
  "supersedes unavailable saved worktree provenance on %s",
  async (action) => {
    const h = harness();
    const branch = action === "create" ? "new" : "adopted";
    const path = join(repo, "trees", branch);
    const saved = { path, identity: "original-checkout", state: "used" as const };
    const parent = h.rows.get("parent");
    if (!parent) throw new Error("missing parent");
    const oldChild = { ...parent, id: "old-child", worktree: path, exited: true };
    h.host.restoreWorktree.mockRejectedValueOnce(new LaunchFailure("timed-out"));
    await h.orchestration.restoreWorktrees("parent", [saved]);
    const pending = await h.orchestration.restoreChild("parent", oldChild);
    if (typeof pending === "boolean") throw new Error("missing deferred proof");
    expect(pending.parentStillActive()).toBe(true);

    const replacement = await h.mutate(
      "create_worktree",
      action === "create" ? { branch } : { pullRequest: 7 },
    );
    expect(replacement.status).toBe("succeeded");
    expect(h.orchestration.savedWorktrees("parent")).toEqual([
      {
        path,
        identity: `id-${branch}`,
        state: "unused",
        ...(action === "adopt" ? { pullRequest: 7 } : {}),
      },
    ]);
    expect(pending.parentStillActive()).toBe(false);
    expect(await h.orchestration.restoreChild("parent", oldChild)).toBe(false);
    expect(h.orchestration.view(oldChild.id)).toBeUndefined();

    await expect(
      h.mutate("launch", { worktreeId: replacement.resultId, agent: "claude" }),
    ).resolves.toMatchObject({ status: "succeeded" });
  },
);

it("charges unverified unused records to the persisted worktree budget", async () => {
  const h = harness();
  h.host.restoreWorktree.mockRejectedValueOnce(new LaunchFailure("timed-out"));
  const tree = {
    path: join(repo, "trees", "unverified"),
    identity: "unverified",
    state: "unused" as const,
  };
  await h.orchestration.restoreWorktrees("parent", [tree], 3);
  await expect(h.mutate("create_worktree", { branch: "too-many" })).rejects.toThrow("capacity");
  expect(h.orchestration.savedWorktrees("parent")).toEqual([tree]);
});

it("keeps outstanding checkout identities in the save while requiring proof for ownership", async () => {
  const h = harness();
  const trees = ["stalled", "queued"].map((branch) => ({
    path: join(repo, "trees", branch),
    identity: `id-${branch}`,
    state: "used" as const,
  }));
  const check = Promise.withResolvers<{ branch: string; identity: string }>();
  h.host.restoreWorktree.mockReturnValueOnce(check.promise);
  const restoring = h.orchestration.restoreWorktrees("parent", trees);
  expect(h.orchestration.savedWorktrees("parent")).toEqual(trees);
  expect(h.orchestration.ownedWorktrees("parent")).toEqual([]);

  check.reject(new LaunchFailure("remote_worktree_unavailable"));
  await restoring;
  expect(h.orchestration.savedWorktrees("parent")).toEqual([trees[1]]);
});

it("refuses an old child when creation supersedes the checkout during an outstanding check", async () => {
  const h = harness();
  const path = join(repo, "trees", "replacement");
  const parent = h.rows.get("parent");
  if (!parent) throw new Error("missing parent");
  const check = Promise.withResolvers<{ branch: string; identity: string }>();
  h.host.restoreWorktree.mockReturnValueOnce(check.promise);
  const restoring = h.orchestration.restoreWorktrees("parent", [
    { path, identity: "old-checkout", state: "used" },
  ]);
  await expect(h.mutate("create_worktree", { branch: "replacement" })).resolves.toMatchObject({
    status: "succeeded",
  });
  check.reject(new LaunchFailure("timed-out"));
  await restoring;
  expect(
    await h.orchestration.restoreChild("parent", {
      ...parent,
      id: "old-child",
      worktree: path,
      exited: true,
    }),
  ).toBe(false);
  expect(h.orchestration.savedWorktrees("parent")).toEqual([
    { path, identity: "id-replacement", state: "unused" },
  ]);
});
