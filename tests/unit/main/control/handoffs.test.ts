import { describe, expect, it, vi } from "vitest";
import { Handoffs } from "../../../../src/main/control/handoffs";
import {
  handoffRequest,
  readHandoffRequest,
  storedHandoffs,
} from "../../../../src/node-common/handoff";
import type { Principal } from "../../../../src/main/control/types";

const actor: Principal = {
  grantedAt: "2026-10-15T00:00:00.000Z",
  generation: "generation",
  sessionId: "session",
  terminalId: "child",
  parentId: "parent",
  role: "agent",
  repository: "/repo",
  worktree: "/repo/child",
};
const request = {
  status: "done",
  summary: "Finished\n\t✓",
  links: ["https://example.com/pr/1"],
  idempotencyKey: "key",
};

describe("handoff boundary", () => {
  it.each([
    { status: "waiting" },
    { summary: "" },
    { summary: "é".repeat(4097) },
    { summary: "carriage\rreturn" },
    { summary: "escape\u001b" },
    { summary: "c1\u0085" },
    { summary: 1 },
    { links: "https://example.com" },
    { links: Array(11).fill("https://example.com") },
    { links: [1] },
    { links: ["https://example.com/" + "a".repeat(2048)] },
    { links: ["http://example.com"] },
    { links: ["javascript:alert(1)"] },
    { links: ["https://"] },
    { links: ["https://example.com/\n"] },
    { idempotencyKey: "" },
    { recipient: "foreign" },
  ])("rejects malformed input %j", (change) => {
    expect(() => handoffRequest({ ...request, ...change })).toThrow("invalid_request");
  });
  it("accepts exact UTF-8 bounds and only positive safe sequence selectors", () => {
    expect(
      handoffRequest({ ...request, summary: "é".repeat(4096), links: undefined }).links,
    ).toEqual([]);
    expect(readHandoffRequest({ id: "child" })).toEqual({ id: "child" });
    expect(readHandoffRequest({ id: "child", seq: 1 })).toEqual({ id: "child", seq: 1 });
    for (const value of [0, -1, 1.5, "1", Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => readHandoffRequest({ id: "child", seq: value })).toThrow("invalid_request");
    expect(() => readHandoffRequest({ id: "child", parent: "other" })).toThrow("invalid_request");
  });
  it("validates persisted reports and rejects duplicates, ordering, invalid dates and extras", () => {
    const report = {
      seq: 1,
      status: "done",
      summary: "done",
      links: [],
      timestamp: "2026-10-15T00:00:00.000Z",
    };
    expect(storedHandoffs([report])).toEqual([report]);
    for (const value of [
      null,
      Array(21).fill(report),
      [report, report],
      [{ ...report, seq: 0 }],
      [{ ...report, timestamp: "bad" }],
      [{ ...report, timestamp: "2026-10-15" }],
      [{ ...report, extra: true }],
    ])
      expect(() => storedHandoffs(value)).toThrow("invalid_request");
  });
});

describe("bounded pull-only handoff journal", () => {
  it("serializes concurrent duplicates, rate limits new reports, retains twenty and replays evicted results", async () => {
    const journal = new Handoffs();
    let now = 0;
    const audit = vi.fn(() => Promise.resolve());
    const persist = vi.fn(() => Promise.resolve());
    const record = (params = request) =>
      journal.record(
        actor,
        params,
        () => {},
        audit,
        persist,
        () => now,
      );
    expect(journal.latest("missing")).toBeUndefined();
    const [first, replay] = await Promise.all([record(), record()]);
    expect(replay).toEqual(first);
    expect(audit).toHaveBeenCalledTimes(1);
    await expect(record({ ...request, summary: "different" })).rejects.toThrow("conflict");
    await expect(record({ ...request, idempotencyKey: "new" })).rejects.toThrow("capacity");
    for (let index = 2; index <= 21; index++) {
      now += 10000;
      await record({ ...request, idempotencyKey: `key-${String(index)}` });
    }
    expect(journal.entries("child")).toHaveLength(20);
    expect(journal.entries("child")[0]?.seq).toBe(2);
    expect(await record()).toEqual(first);
    const restored = new Handoffs();
    restored.restore("child", journal.entries("child"));
    expect(restored.latest("child")?.seq).toBe(21);
    restored.remove("child");
    expect(restored.entries("child")).toEqual([]);
  });
  it("refuses audit failures, rechecks authority after audit and recovers lost persistence acknowledgement", async () => {
    const journal = new Handoffs();
    const active = vi.fn();
    const persist = vi.fn(() => Promise.resolve());
    await expect(
      journal.record(
        actor,
        request,
        active,
        () => Promise.reject(new Error("disk")),
        persist,
        () => 0,
      ),
    ).rejects.toThrow("disk");
    expect(journal.entries("child")).toEqual([]);
    await expect(
      journal.record(
        actor,
        request,
        active,
        () => {
          active.mockImplementation(() => {
            throw new Error("no_parent");
          });
          return Promise.resolve();
        },
        persist,
        () => 0,
      ),
    ).rejects.toThrow("no_parent");
    expect(journal.entries("child")).toEqual([]);
    active.mockImplementation(() => {});
    const audit = vi.fn(() => Promise.resolve());
    persist.mockRejectedValueOnce(new Error("disk"));
    await expect(journal.record(actor, request, active, audit, persist, () => 0)).rejects.toThrow(
      "disk",
    );
    expect(await journal.record(actor, request, active, audit, persist, () => 0)).toMatchObject({
      seq: 1,
    });
    expect(audit).toHaveBeenCalledTimes(1);
  });
  it("refuses sequence overflow and bounded deduplication exhaustion", async () => {
    const journal = new Handoffs();
    journal.restore("overflow", [
      {
        seq: Number.MAX_SAFE_INTEGER,
        status: "done",
        summary: "ok",
        links: [],
        timestamp: new Date(0).toISOString(),
      },
    ]);
    const record = (id: string, key: string) =>
      journal.record(
        { ...actor, terminalId: id },
        { ...request, idempotencyKey: key },
        () => {},
        () => Promise.resolve(),
        () => Promise.resolve(),
        () => 20000,
      );
    await expect(record("overflow", "overflow")).rejects.toThrow("capacity");
    for (let index = 0; index < 4096; index++)
      await record(`child-${String(index)}`, `key-${String(index)}`);
    await expect(record("extra", "extra")).rejects.toThrow("capacity");
  });
});
