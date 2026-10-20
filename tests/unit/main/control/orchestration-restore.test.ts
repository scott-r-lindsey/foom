import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { locationId } from "../../../../src/main/control/metadata";
import { Orchestration } from "../../../../src/main/control/orchestration";
import type { WorkspaceTerminal } from "../../../../src/shared/workspace";

import { harness, other, repo } from "./orchestration-helpers";

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
