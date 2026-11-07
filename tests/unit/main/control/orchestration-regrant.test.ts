import { expect, it, vi } from "vitest";
import { harness, repo } from "./orchestration-helpers";

for (const remote of [false, true]) {
  it(`restores owned ${remote ? "remote" : "local"} children and cleanup on a human re-grant`, async () => {
    const h = harness();
    try {
      const child = await h.child("recover");
      const taken = await h.child("taken");
      const row = h.rows.get(child.id);
      if (!row) throw new Error("missing child");
      row.state = {
        id: child.id,
        verdictId: "permission",
        state: "needs_input",
        reason: "fixture",
        signal: "fixture",
        timestamp: 1,
        confidence: 1,
        attentionKind: "permission",
      };
      if (remote)
        h.rows.set(child.id, {
          ...row,
          remote: true,
          placement: { kind: "remote", host: "fixture" },
        });
      const grant = h.service.prepare(repo, row.worktree, "agent", "parent");
      grant.bind(child.id);
      const actor = h.service.authenticate(grant.env["FOOM_CONTROL_TOKEN"] ?? "");
      const report = () =>
        h.service.call(actor, {
          version: 1,
          instanceId: h.service.instanceId,
          method: "handoff",
          params: { status: "blocked", summary: "Permission prompt", idempotencyKey: "report" },
        });
      await report();
      h.orchestration.takeOver(taken.id);
      h.service.setRole("parent", "agent");
      h.orchestration.revoke("parent");
      await expect(h.call("tail", { id: child.id })).rejects.toMatchObject({
        code: "unauthorized",
      });
      await expect(report()).rejects.toMatchObject({ code: "no_parent" });
      // A different granted session never inherits the old parent's children.
      const other = h.launchParent("other");
      await expect(other.call("tail", { id: child.id })).rejects.toMatchObject({
        code: "not_found",
      });
      h.orchestration.revoke("other");
      h.service.setRole("other", "agent");
      const slot = h.orchestration.reserve(repo);
      if ("existing" in slot) throw new Error("slot taken");
      h.service.setRole("parent", "orchestrator");
      slot.bind("parent");
      await expect(h.call("tail", { id: child.id })).rejects.toMatchObject({
        code: "unauthorized",
      });
      const current = h.service.authenticate(h.grant.env["FOOM_CONTROL_TOKEN"] ?? "");
      const call = (method: string, params: Record<string, unknown>) =>
        h.service.call(current, {
          version: 1,
          instanceId: h.service.instanceId,
          method,
          params,
        });
      expect(await call("tail", { id: child.id })).toMatchObject({ lines: ["ready"] });
      expect(await call("read_handoff", { id: child.id })).toMatchObject({
        summary: "Permission prompt",
      });
      await report();
      await call("prompt", { id: child.id, text: "Allow", idempotencyKey: "prompt" });
      await call("send_keys", { id: child.id, keys: ["enter"], idempotencyKey: "keys" });
      expect(h.host.reply).toHaveBeenCalledTimes(2);
      await expect(call("tail", { id: taken.id })).rejects.toMatchObject({ code: "not_found" });
      await call("stop", { id: child.id, idempotencyKey: "stop" });
      h.exit(child.id);
      await call("close", { id: child.id, idempotencyKey: "close" });
      h.rows.delete(child.id);
      h.orchestration.removed(child.id);
      await call("remove_worktree", { worktreeId: child.worktreeId, idempotencyKey: "remove" });
      expect(h.host.remove).toHaveBeenCalled();
    } finally {
      h.orchestration.disposeUnreadChildren();
      h.service.close();
    }
  });
}

it("allows same-tile resume only from an exit, invalidated by revoke, replacement or new conversation", () => {
  const h = harness();
  try {
    expect(h.orchestration.resumeGuard("parent", repo)).toBeUndefined();
    h.exit("parent");
    expect(h.orchestration.resumeGuard("parent", `${repo}-other`)).toBeUndefined();
    const guard = h.orchestration.resumeGuard("parent", repo);
    expect(guard).toBeTypeOf("function");
    guard?.();
    h.orchestration.revoke("parent");
    expect(() => guard?.()).toThrow();
    expect(h.orchestration.resumeGuard("parent", repo)).toBeUndefined();
  } finally {
    h.orchestration.disposeUnreadChildren();
    h.service.close();
  }
});

it("cancels exit provenance after another human grant, new conversation or removal", () => {
  for (const action of ["transfer", "new-conversation", "remove"] as const) {
    const h = harness();
    try {
      h.exit("parent");
      const guard = h.orchestration.resumeGuard("parent", repo);
      if (action === "transfer") {
        h.launchParent("replacement");
        expect(h.orchestration.resumeGuard("parent", repo)).toBeUndefined();
        h.orchestration.revoke("replacement");
      } else if (action === "remove") h.orchestration.removed("parent");
      else h.orchestration.relaunched("parent");
      expect(() => guard?.()).toThrow();
      expect(h.orchestration.resumeGuard("parent", repo)).toBeUndefined();
    } finally {
      h.orchestration.disposeUnreadChildren();
      h.service.close();
    }
  }
});

it("waits for retired worktree creation to settle before recovering ownership", async () => {
  const h = harness();
  try {
    let complete: ((tree: { path: string; branch: string; identity: string }) => void) | undefined;
    h.host.createWorktree.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = h.mutate("create_worktree", { branch: "pending" });
    // Operation persistence precedes the host's creation effect.
    await vi.waitFor(() => {
      expect(complete).toBeTypeOf("function");
    });
    h.exit("parent");
    const guard = h.orchestration.resumeGuard("parent", repo);
    expect(() => guard?.()).toThrow("conflict");
    expect(() => h.orchestration.reserve(repo, "parent")).toThrow("conflict");
    const slot = h.orchestration.reserve(repo);
    if ("existing" in slot) throw new Error("slot taken");
    expect(() => {
      slot.bind("parent");
    }).toThrow("conflict");
    slot.release();
    complete?.({ path: `${repo}/pending`, branch: "pending", identity: "pending" });
    await pending;
    expect(() => guard?.()).not.toThrow();
    const next = h.orchestration.reserve(repo);
    if ("existing" in next) throw new Error("slot taken");
    next.bind("parent");
    expect(h.orchestration.ownedWorktrees("parent")).toMatchObject([{ path: `${repo}/pending` }]);
  } finally {
    h.orchestration.disposeUnreadChildren();
    h.service.close();
  }
});

it("recovers children under fresh resume credentials while the old credential stays revoked", async () => {
  const h = harness();
  try {
    const child = await h.child("resume");
    h.exit("parent");
    h.grant.dispose();
    const resumed = h.launchParent("parent");
    expect(resumed.actor.generation).not.toBe(h.actor.generation);
    await expect(h.call("tail", { id: child.id })).rejects.toMatchObject({ code: "unauthorized" });
    expect(await resumed.call("tail", { id: child.id })).toMatchObject({ lines: ["ready"] });
  } finally {
    h.orchestration.disposeUnreadChildren();
    h.service.close();
  }
});
