import { describe, expect, it } from "vitest";

import { harness, other } from "./orchestration-helpers";

describe("owned child prompt and keys", () => {
  it.each(["done", "quiet_ok", "working", "needs_input"] as const)(
    "sends input in %s without review and audits only hashes",
    async (state) => {
      const h = harness();
      const { id } = await h.child("input");
      const row = h.rows.get(id);
      if (!row) throw new Error("missing child");
      row.state = {
        id,
        verdictId: "fixture-verdict",
        state,
        reason: "fixture",
        signal: "fixture",
        timestamp: 1,
        confidence: 1,
        attentionKind: "permission",
      };
      const params = { id, text: "private follow-up\nnext line", idempotencyKey: "input" };
      expect(await h.call("prompt", params)).toMatchObject({ status: "succeeded" });
      expect(await h.call("prompt", params)).toMatchObject({ status: "succeeded" });
      expect(h.host.reply).toHaveBeenCalledExactlyOnceWith(id, {
        kind: "prompt",
        text: params.text,
      });
      expect(h.host.dialog).not.toHaveBeenCalled();
      await expect(h.call("prompt", { ...params, text: "different" })).rejects.toThrow("conflict");
      expect(await h.mutate("send_keys", { id, keys: ["down", "y", "enter"] })).toMatchObject({
        status: "succeeded",
      });
      const audit = JSON.stringify(h.persist.mock.calls);
      expect(audit).not.toContain(params.text);
      expect(audit).not.toContain('"keys"');
      expect(audit).not.toContain('"proposal"');
      const record = h.persist.mock.calls.at(-1)?.[0];
      expect(record?.operation.inputHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(record?.operation.inputHash).not.toBe(record?.fingerprint);
    },
  );
  it("refuses foreign, human, unknown, taken-over and other-repository targets identically", async () => {
    const h = harness();
    const own = await h.child("own");
    const foreign = h.launchParent("foreign-parent", other);
    const child = await h.child("foreign", foreign.mutate);
    h.orchestration.takeOver(own.id);
    for (const id of ["unknown", "parent", own.id, child.id]) {
      for (const method of ["prompt", "send_keys"]) {
        await expect(
          h.mutate(method, { id, ...(method === "prompt" ? { text: "yes" } : { keys: ["y"] }) }),
        ).rejects.toThrow("not_found");
      }
    }
    const cross = await h.child("cross");
    const row = h.rows.get(cross.id);
    if (!row) throw new Error("missing child");
    row.repository = other;
    await expect(h.mutate("prompt", { id: cross.id, text: "yes" })).rejects.toThrow("not_found");
    h.orchestration.revoke("parent");
    await expect(h.mutate("prompt", { id: cross.id, text: "yes" })).rejects.toThrow("forbidden");
    expect(h.host.reply).not.toHaveBeenCalled();
  });
  it.each([{ config: true }, { probe: true }, { kind: "shell" as const }])(
    "refuses config/probe/non-agent sessions even with a matching ownership record: %j",
    async (flags) => {
      const h = harness();
      const child = await h.child("scoped-input");
      const row = h.rows.get(child.id);
      if (!row) throw new Error("missing child");
      h.rows.set(child.id, { ...row, ...flags });
      h.rows.set("config-probe", {
        ...row,
        id: "config-probe",
        config: true,
        probe: true,
        probeOwner: "parent",
      });
      h.rows.set("config-driver", { ...row, id: "config-driver", config: true });
      const before = h.persist.mock.calls.length;
      for (const id of [child.id, "config-probe", "config-driver", "unknown"]) {
        await expect(h.mutate("prompt", { id, text: "follow up" })).rejects.toThrow("not_found");
        await expect(h.mutate("send_keys", { id, keys: ["y", "enter"] })).rejects.toThrow(
          "not_found",
        );
      }
      expect(h.persist.mock.calls.length).toBe(before);
      expect(h.host.reply).not.toHaveBeenCalled();
      const owned = await h.child("normal-child");
      expect(await h.mutate("prompt", { id: owned.id, text: "follow up" })).toMatchObject({
        status: "succeeded",
      });
      expect(await h.mutate("send_keys", { id: owned.id, keys: ["enter"] })).toMatchObject({
        status: "succeeded",
      });
      expect(h.host.reply).toHaveBeenCalledTimes(2);
    },
  );
  it("rejects malformed payloads before audit intent or any write", async () => {
    const h = harness();
    const { id } = await h.child("validation");
    const before = h.persist.mock.calls.length;
    for (const text of ["", " ", "\x1b[201~", "\0", "\r", "\u202e", "é".repeat(8193), 1])
      await expect(h.mutate("prompt", { id, text })).rejects.toThrow("invalid_request");
    for (const keys of [[], ["y", "bad"], ["ENTER"], ["__proto__"], [1], null, Array(65).fill("y")])
      await expect(h.mutate("send_keys", { id, keys })).rejects.toThrow("invalid_request");
    await expect(h.mutate("prompt", { id, text: "yes", force: true })).rejects.toThrow(
      "invalid_request",
    );
    await expect(h.mutate("send_keys", { id: "../bad", keys: ["y"] })).rejects.toThrow(
      "invalid_request",
    );
    expect(h.persist.mock.calls.length).toBe(before);
    expect(h.host.reply).not.toHaveBeenCalled();
    expect(await h.mutate("prompt", { id, text: "é".repeat(8192) })).toMatchObject({
      status: "succeeded",
    });
    h.exit(id);
    await expect(h.mutate("send_keys", { id, keys: ["enter"] })).rejects.toThrow("conflict");
  });
  it.each(["takeover", "revoke", "exit", "audit"])(
    "rechecks authority after audit during %s",
    async (event) => {
      const h = harness();
      const { id } = await h.child("race");
      h.persist.mockImplementationOnce(() => {
        if (event === "takeover") h.orchestration.takeOver(id);
        if (event === "revoke") h.grant.dispose();
        if (event === "exit") h.exit(id);
        return event === "audit" ? Promise.reject(new Error("disk")) : Promise.resolve();
      });
      const result = h.mutate("prompt", { id, text: "yes" });
      if (event === "takeover" || event === "exit")
        expect(await result).toMatchObject({ status: "failed" });
      else await expect(result).rejects.toThrow();
      expect(h.host.reply).not.toHaveBeenCalled();
    },
  );
  it("does not retry ambiguous delivery or missing adapters", async () => {
    const h = harness();
    const { id } = await h.child("ambiguous");
    h.host.reply.mockRejectedValue(new Error("may have written"));
    const params = { id, keys: ["y", "enter"], idempotencyKey: "send" };
    expect(await h.call("send_keys", params)).toMatchObject({ status: "indeterminate" });
    expect(await h.call("send_keys", params)).toMatchObject({ status: "indeterminate" });
    expect(h.host.reply).toHaveBeenCalledTimes(1);
    Reflect.deleteProperty(h.host, "reply");
    expect(await h.mutate("prompt", { id, text: "yes" })).toMatchObject({ status: "failed" });
  });
});
