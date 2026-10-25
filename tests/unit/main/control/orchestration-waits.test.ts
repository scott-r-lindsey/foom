import { describe, expect, it, vi } from "vitest";

import { SessionMetadata } from "../../../../src/main/control/metadata";
import { harness } from "./orchestration-helpers";

describe("blocking child-event waits", () => {
  it("captures a baseline, ignores unrelated notifications and wakes on state and PR metadata", async () => {
    const h = harness();
    const { id } = await h.child("event");
    const off = vi.fn();
    const subscribe = h.orchestration.childEvents.subscribe.bind(h.orchestration.childEvents);
    vi.spyOn(h.orchestration.childEvents, "subscribe").mockImplementation((listener, deadline) => {
      const dispose = subscribe(listener, deadline);
      return () => {
        off();
        dispose();
      };
    });
    let settled = false;
    const wait = h.call("wait_for", { untilEvent: true }).then((result) => {
      settled = true;
      return result;
    });
    h.orchestration.childEvents.publish();
    await Promise.resolve();
    expect(settled).toBe(false);
    const row = h.rows.get(id);
    if (!row) throw new Error("missing child");
    h.rows.set(id, { ...row, exited: true });
    h.orchestration.childEvents.publish();
    expect(await wait).toMatchObject({
      changed: [id],
      timedOut: false,
      sessions: [{ state: "exited" }],
    });
    expect(off).toHaveBeenCalledTimes(1);
    const next = h.call("wait_for", { ids: [id], untilEvent: true });
    h.host.forge.read.mockReturnValue({
      number: 549,
      headSha: "a".repeat(40),
      state: "OPEN",
      requiredChecks: "success",
    });
    h.orchestration.childEvents.publish();
    expect(await next).toMatchObject({
      changed: [id],
      timedOut: false,
      sessions: [{ pullRequest: { requiredChecks: "success" } }],
    });
  });

  it("ignores output-only revisions and resumes from the returned event cursor", async () => {
    const h = harness();
    const { id } = await h.child("event");
    const before = (await h.call("session_state", { id })) as { revision: string };
    let settled = false;
    const wait = h.call("wait_for", { ids: [id], untilEvent: true }).then((result) => {
      settled = true;
      return result as { sessions: { event: string }[] };
    });
    const row = h.rows.get(id);
    if (!row) throw new Error("missing child");
    h.rows.set(id, { ...row, outputRevision: (row.outputRevision ?? 0) + 1 });
    h.orchestration.childEvents.publish();
    await Promise.resolve();
    await Promise.resolve();
    const after = (await h.call("session_state", { id })) as { revision: string };
    expect(after.revision).not.toBe(before.revision);
    expect(settled).toBe(false);
    const current = h.rows.get(id);
    if (!current) throw new Error("missing child");
    h.rows.set(id, { ...current, exited: true });
    h.orchestration.childEvents.publish();
    const result = await wait;
    expect(result).toMatchObject({ changed: [id], timedOut: false });
    const cursor = result.sessions[0]?.event;
    if (!cursor) throw new Error("missing event cursor");
    expect(
      await h.call("wait_for", {
        ids: [id],
        untilEvent: true,
        after: { [id]: cursor },
        timeoutMs: 5,
      }),
    ).toMatchObject({ changed: [], timedOut: true });
    const live = (await h.call("session_state", { id })) as { revision: string };
    expect(
      await h.call("wait_for", {
        ids: [id],
        untilEvent: true,
        after: { [id]: live.revision },
        timeoutMs: 5,
      }),
    ).toMatchObject({ changed: [], timedOut: true });
  });

  it("supports cursors, overall timeout and validates long-wait parameters", async () => {
    const h = harness();
    const { id } = await h.child("event");
    expect(
      await h.call("wait_for", { ids: [id], untilEvent: true, after: { [id]: "older" } }),
    ).toMatchObject({ changed: [id], timedOut: false });
    expect(await h.call("wait_for", { untilEvent: true, timeoutMs: 0 })).toMatchObject({
      changed: [],
      timedOut: true,
    });
    expect(await h.call("wait_for", { untilEvent: true, timeoutMs: 5 })).toMatchObject({
      changed: [],
      timedOut: true,
    });
    for (const params of [
      { untilEvent: false },
      { untilEvent: true, ids: null },
      { untilEvent: "true" },
      { untilEvent: true, timeoutMs: -1 },
      { untilEvent: true, timeoutMs: 2147483648 },
      { untilEvent: true, timeoutMs: "5" },
      { untilEvent: true, after: { foreign: "revision" } },
      { untilEvent: true, ids: ["parent"] },
    ])
      await expect(h.call("wait_for", params)).rejects.toThrow(
        params.ids ? "not_found" : "invalid_request",
      );
  });

  it.each(["revoke", "dispose", "role", "close", "takeover", "remove", "relaunch"])(
    "ends and unsubscribes on %s",
    async (action) => {
      const h = harness();
      const { id } = await h.child("event");
      const subscribe = h.orchestration.childEvents.subscribe.bind(h.orchestration.childEvents);
      const off = vi.fn();
      vi.spyOn(h.orchestration.childEvents, "subscribe").mockImplementation(
        (listener, deadline) => {
          const dispose = subscribe(listener, deadline);
          return () => {
            off();
            dispose();
          };
        },
      );
      const wait = h.call("wait_for", { untilEvent: true });
      const rejected = expect(wait).rejects.toThrow();
      if (action === "revoke") h.orchestration.revoke("parent");
      if (action === "dispose") h.grant.dispose();
      if (action === "role") h.service.setRole("parent", "agent");
      if (action === "close") h.service.close();
      if (action === "takeover") h.orchestration.takeOver(id);
      if (action === "remove") h.orchestration.removed(id);
      if (action === "relaunch") h.orchestration.relaunched(id);
      await rejected;
      expect(off).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "releases a disconnected wait (already aborted: %s)",
    async (alreadyAborted) => {
      const h = harness();
      await h.child("event");
      const signal = new AbortController();
      if (alreadyAborted) signal.abort();
      const wait = h.service.call(
        h.actor,
        {
          version: 1,
          instanceId: h.service.instanceId,
          method: "wait_for",
          params: { untilEvent: true },
        },
        signal.signal,
      );
      const rejected = expect(wait).rejects.toThrow("unavailable");
      signal.abort();
      await rejected;
    },
  );
});

it.each([false, true])(
  "batches metadata for multi-child waits (untilEvent: %s)",
  async (untilEvent) => {
    const h = harness();
    const ids = [(await h.child("one")).id, (await h.child("two")).id];
    const states = vi.spyOn(SessionMetadata.prototype, "states");
    try {
      const result = await h.call("wait_for", {
        ids,
        untilEvent: untilEvent || undefined,
        timeoutMs: 0,
      });
      expect(result).toMatchObject({ sessions: ids.map((id) => ({ id })) });
      expect(states).toHaveBeenCalled();
      for (const call of states.mock.calls) expect(call[1]).toEqual(ids);
    } finally {
      states.mockRestore();
    }
  },
);
