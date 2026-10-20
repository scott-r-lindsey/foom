import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { harness, repo } from "./orchestration-helpers";

describe("child handoff ownership and waits", () => {
  async function setup() {
    const h = harness();
    const child = await h.child("reports");
    const grant = h.service.prepare(repo, join(repo, "trees", "reports"), "agent", "parent");
    grant.bind(child.id);
    const actor = h.service.authenticate(grant.env["FOOM_CONTROL_TOKEN"] ?? "");
    const report = (params: Record<string, unknown> = {}) =>
      h.service.call(actor, {
        version: 1,
        instanceId: h.service.instanceId,
        method: "handoff",
        params: { status: "blocked", summary: "CI failed", idempotencyKey: "report", ...params },
      });
    return { h, child, actor, grant, report };
  }
  it.each(["read_handoff", "session_state", "wait_for"])(
    "acknowledges child events through %s, excluding sessions and tail",
    async (method) => {
      const { h, child, actor, report } = await setup();
      await report();
      h.orchestration.syncUnreadChildEvents();
      h.advance(300000);
      expect(h.orchestration.unreadChildren.overdue("parent")).toBeDefined();
      await h.call("sessions");
      await h.service.call(actor, {
        version: 1,
        instanceId: h.service.instanceId,
        method: "session_state",
        params: { id: child.id },
      });
      h.orchestration.childRead(h.actor, "foreign");
      await h.call("tail", { id: child.id });
      expect(h.orchestration.unreadChildren.overdue("parent")).toBeDefined();
      await h.call(method, method === "wait_for" ? { ids: [child.id] } : { id: child.id });
      expect(h.orchestration.unreadChildren.overdue("parent")).toBeUndefined();
      h.orchestration.disposeUnreadChildren();
    },
  );

  it.each([false, true])(
    "acknowledges existing events at wait entry (blocking=%s)",
    async (blocking) => {
      const { h, child, report } = await setup();
      await report();
      h.orchestration.syncUnreadChildEvents();
      h.advance(300000);
      const listed = (await h.call("sessions")) as { sessions: { id: string; revision: string }[] };
      const revision = listed.sessions.find((row) => row.id === child.id)?.revision;
      expect(h.orchestration.unreadChildren.overdue("parent")).toBeDefined();
      await expect(h.call("wait_for", { ids: [child.id, "foreign"] })).rejects.toThrow("not_found");
      expect(h.orchestration.unreadChildren.overdue("parent")).toBeDefined();
      const waiting = h.call("wait_for", {
        ids: [child.id],
        after: { [child.id]: revision },
        timeoutMs: 1000,
        ...(blocking ? { untilEvent: true } : {}),
      });
      expect(h.orchestration.unreadChildren.overdue("parent")).toBeUndefined();
      h.exit(child.id);
      await expect(waiting).resolves.toMatchObject({ changed: [child.id], timedOut: false });
      h.advance(300000);
      expect(h.orchestration.unreadChildren.overdue("parent")).toBeUndefined();
      h.orchestration.disposeUnreadChildren();
    },
  );

  it("observes the shared child-event stream and unsubscribes at disposal", async () => {
    const { h, child } = await setup();
    const row = h.rows.get(child.id);
    if (!row) throw new Error("Missing child");
    h.rows.set(child.id, {
      ...row,
      execution: { terminalId: child.id, launch: 1, revision: 1, turn: 1, phase: "idle" },
    });
    h.orchestration.childEvents.publish();
    await Promise.resolve();
    h.advance(300000);
    expect(h.orchestration.unreadChildren.overdue("parent")).toBeDefined();
    h.orchestration.disposeUnreadChildren();
    h.orchestration.childEvents.publish();
    await Promise.resolve();
    expect(h.orchestration.unreadChildren.overdue("parent")).toBeUndefined();
  });

  it("counts running children and unread reports, clearing only the latest read", async () => {
    const { h, child, report } = await setup();
    expect(h.orchestration.waitingOn("missing")).toBe(0);
    expect(h.orchestration.waitingOn("parent")).toBe(1);
    await report();
    h.exit(child.id);
    expect(h.orchestration.waitingOn("parent")).toBe(1);
    await h.call("read_handoff", { id: child.id });
    expect(h.orchestration.waitingOn("parent")).toBe(0);
  });
  it("keeps newer reports unread and permits a running child to hand off", async () => {
    const { h, child, report } = await setup();
    await report();
    await h.call("read_handoff", { id: child.id });
    expect(h.orchestration.waitingOn("parent")).toBe(0);
    h.advance(10000);
    await report({ idempotencyKey: "next" });
    await h.call("read_handoff", { id: child.id, seq: 1 });
    expect(h.orchestration.waitingOn("parent")).toBe(1);
    await h.call("read_handoff", { id: child.id });
    await h.call("read_handoff", { id: child.id, seq: 1 });
    expect(h.orchestration.waitingOn("parent")).toBe(0);
  });
  it.each(["exit", "takeover", "revoke", "parent-exit", "close"])(
    "clears waiting on the last child's %s",
    async (change) => {
      const { h, child } = await setup();
      expect(h.orchestration.waitingOn("parent")).toBe(1);
      if (change === "exit") h.exit(child.id);
      else if (change === "takeover") h.orchestration.takeOver(child.id);
      else if (change === "revoke") h.orchestration.revoke("parent");
      else if (change === "parent-exit") h.exit("parent");
      else h.orchestration.removed(child.id);
      expect(h.orchestration.waitingOn("parent")).toBe(0);
    },
  );
  it("lists reports only for children, reads only for parents, and wakes a metadata-only wait", async () => {
    const { h, child, actor, report } = await setup();
    expect(h.service.listed(actor)).toContain("handoff");
    expect(h.service.listed(actor)).not.toContain("read_handoff");
    expect(h.service.listed(h.actor)).toContain("read_handoff");
    expect(h.service.listed(h.actor)).not.toContain("handoff");
    const ordinary = h.service.prepare(repo, repo);
    ordinary.bind("ordinary");
    const plain = h.service.authenticate(ordinary.env["FOOM_CONTROL_TOKEN"] ?? "");
    expect(h.service.listed(plain)).not.toContain("handoff");
    await expect(
      h.service.call(plain, {
        version: 1,
        instanceId: h.service.instanceId,
        method: "handoff",
        params: {},
      }),
    ).rejects.toThrow("no_parent");
    await expect(h.call("handoff", {})).rejects.toThrow("no_parent");
    await expect(h.call("read_handoff", { id: child.id })).rejects.toThrow("not_found");
    const state = (await h.call("session_state", { id: child.id })) as { revision: string };
    vi.useFakeTimers();
    try {
      const wait = h.call("wait_for", {
        ids: [child.id],
        after: { [child.id]: state.revision },
        timeoutMs: 1000,
      });
      const blocking = h.call("wait_for", { ids: [child.id], untilEvent: true });
      await report();
      await vi.advanceTimersByTimeAsync(250);
      expect(await blocking).toMatchObject({
        changed: [child.id],
        timedOut: false,
        sessions: [{ handoff: { seq: 1, status: "blocked" } }],
      });
      const result = await wait;
      expect(result).toMatchObject({
        changed: [child.id],
        timedOut: false,
        sessions: [{ handoff: { seq: 1, status: "blocked" } }],
      });
      expect(JSON.stringify(result)).not.toContain("CI failed");
    } finally {
      vi.useRealTimers();
    }
    expect(await h.call("read_handoff", { id: child.id })).toMatchObject({
      seq: 1,
      summary: "CI failed",
      untrusted: true,
    });
    expect(await h.call("read_handoff", { id: child.id, seq: 1 })).toMatchObject({ seq: 1 });
    await expect(h.call("read_handoff", { id: child.id, seq: 2 })).rejects.toThrow("not_found");
    await expect(h.call("read_handoff", { id: "foreign" })).rejects.toThrow("not_found");
    await expect(
      h.service.call(actor, {
        version: 1,
        instanceId: h.service.instanceId,
        method: "read_handoff",
        params: { id: child.id },
      }),
    ).rejects.toThrow("forbidden");
  });
  it.each(["takeover", "revoke", "exit", "transfer"])("ends handoff access on %s", async (kind) => {
    const { h, child, actor, report } = await setup();
    await report();
    if (kind === "takeover") h.orchestration.takeOver(child.id);
    else if (kind === "exit") h.exit("parent");
    else {
      h.orchestration.revoke("parent");
      if (kind === "transfer") {
        const next = h.launchParent("replacement");
        await expect(next.call("read_handoff", { id: child.id })).rejects.toThrow("not_found");
      }
    }
    expect(h.service.listed(actor)).not.toContain("handoff");
    await expect(report()).rejects.toThrow("no_parent");
    await expect(h.call("read_handoff", { id: child.id })).rejects.toThrow();
    expect(h.orchestration.handoffs.latest(child.id)?.summary).toBe("CI failed");
  });
  it("restores access only after ownership is restored and deletes reports on close", async () => {
    const { h, child, report } = await setup();
    await report();
    h.orchestration.revoke("parent");
    const next = h.launchParent("parent");
    await expect(next.call("read_handoff", { id: child.id })).rejects.toThrow("not_found");
    const row = h.rows.get(child.id);
    if (!row) throw new Error("missing child");
    await h.orchestration.restoreChild("parent", row);
    expect(await next.call("read_handoff", { id: child.id })).toMatchObject({ seq: 1 });
    h.orchestration.removed(child.id);
    expect(h.orchestration.handoffs.latest(child.id)).toBeUndefined();
  });
});
