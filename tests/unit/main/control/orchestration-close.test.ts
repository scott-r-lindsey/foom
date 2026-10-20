import { describe, expect, it } from "vitest";

import { harness, history, other } from "./orchestration-helpers";

describe("close exited children", () => {
  it("places a new child once, but never places restored children", async () => {
    const h = harness();
    const { id } = await h.child("placed");
    expect(h.host.place).toHaveBeenCalledExactlyOnceWith(id, "parent");
    const row = h.rows.get(id);
    if (!row) throw new Error("Missing child");
    await h.orchestration.restoreChild("parent", row);
    expect(h.host.place).toHaveBeenCalledTimes(1);
  });

  it.each(["running", "stopping", "taken-over", "foreign", "unknown"])(
    "refuses a %s child with a fixed reason and records the refusal",
    async (state) => {
      const h = harness();
      const { id } = await h.child("feature");
      if (state === "stopping") await h.mutate("stop", { id });
      if (state === "taken-over") {
        h.exit(id);
        h.orchestration.takeOver(id);
      }
      const caller = state === "foreign" ? h.launchParent("other-parent", other) : h;
      const target = state === "unknown" ? "missing" : id;
      const reason =
        state === "taken-over"
          ? "forbidden"
          : state === "foreign" || state === "unknown"
            ? "not_found"
            : "conflict";
      await expect(caller.mutate("close", { id: target })).rejects.toThrow(reason);
      expect(h.host.close).not.toHaveBeenCalled();
      expect(history(h.orchestration.view(caller.actor.terminalId)).at(-1)).toMatchObject({
        action: "close",
        status: "failed",
      });
      expect(h.persist.mock.calls.at(-1)?.[0].operation.reason).toBe("refused");
    },
  );

  it("closes an exited child once with an operation, keeping the owned worktree", async () => {
    const h = harness();
    const { id } = await h.child("feature");
    h.exit(id);
    h.host.close.mockImplementation((target) => {
      h.rows.delete(target);
      h.orchestration.removed(target);
      return Promise.resolve();
    });
    const params = { id, idempotencyKey: "close-once" };
    const first = await h.call("close", params);
    expect(first).toMatchObject({ action: "close", status: "succeeded", resultId: id });
    expect(await h.call("close", params)).toEqual(first);
    expect(h.host.close).toHaveBeenCalledExactlyOnceWith(id);
    expect(h.orchestration.ownedWorktrees("parent")).toHaveLength(1);
    expect(h.host.remove).not.toHaveBeenCalled();
    expect(history(h.orchestration.view("parent")).at(-1)?.action).toBe("close");
  });

  it("records a close failure without removing child ownership", async () => {
    const h = harness();
    const { id } = await h.child("feature");
    h.exit(id);
    h.host.close.mockRejectedValueOnce(new Error("host failure"));
    expect(await h.mutate("close", { id })).toMatchObject({ status: "failed" });
    expect(h.orchestration.view(id)).toMatchObject({ role: "child" });
  });
});
