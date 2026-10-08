import { locationId, metadataName } from "../../../../src/main/control/metadata";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { ControlService } from "../../../../src/main/control/service";
import { Operations } from "../../../../src/main/control/operations";
import { ControlError, identifier, object } from "../../../../src/main/control/validation";
import type { StoredOperation } from "../../../../src/main/control/types";

const repo = join(tmpdir(), "repo");
function fixture(limit = 4096) {
  const persist = vi.fn((_record: StoredOperation) => Promise.resolve());
  const operations = new Operations(
    persist,
    (actor) => {
      service.assertActive(actor);
    },
    limit,
  );
  const service = new ControlService(operations);
  const grant = service.prepare(repo, repo, "orchestrator");
  const token = grant.env["FOOM_CONTROL_TOKEN"] ?? "";
  grant.bind("terminal");
  const actor = service.authenticate(token);
  const request = (method: string, params: unknown = {}) => ({
    version: 1,
    instanceId: service.instanceId,
    method,
    params,
  });
  return { service, operations, grant, actor, token, persist, request };
}

describe("control identity and capability checks", () => {
  it("binds once, returns immutable metadata, never authorizes a hook token or correlation ID", () => {
    const { service, actor, token, grant, request } = fixture();
    expect(token).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(actor)).toBe(true);
    expect(service.dispatch(actor, request("whoami"))).toEqual({
      ...actor,
      repository: locationId(actor.repository),
      worktree: locationId(actor.worktree),
      name: metadataName(basename(actor.worktree)),
      capabilities: ["whoami", "sessions", "session_state", "operation_status"],
    });
    expect(JSON.stringify(service.dispatch(actor, request("whoami")))).not.toContain(token);
    expect(() => {
      grant.bind("other");
    }).toThrow("unauthorized");
    for (const value of ["", actor.sessionId, "hook-token"])
      expect(() => service.authenticate(value)).toThrow("unauthorized");
    grant.dispose();
    grant.dispose();
    expect(() => service.authenticate(token)).toThrow("unauthorized");
    expect(() => service.dispatch(actor, request("whoami"))).toThrow("unauthorized");
    expect(() => {
      grant.bind("late");
    }).toThrow("unauthorized");
    const fresh = service.prepare(repo, repo);
    expect(fresh.env["FOOM_CONTROL_TOKEN"]).not.toBe(token);
    expect(() => service.authenticate(fresh.env["FOOM_CONTROL_TOKEN"] ?? "")).toThrow(
      "unauthorized",
    );
    fresh.bind("replacement");
    const reader = service.authenticate(fresh.env["FOOM_CONTROL_TOKEN"] ?? "");
    expect(service.dispatch(reader, request("whoami"))).toMatchObject({
      role: "agent",
      capabilities: ["whoami", "sessions", "session_state"],
    });
    expect(() =>
      service.dispatch(reader, request("operation_status", { operationId: "id" })),
    ).toThrow("forbidden");
    service.close();
    service.close();
    expect(() => service.authenticate(fresh.env["FOOM_CONTROL_TOKEN"] ?? "")).toThrow(
      "unauthorized",
    );
    expect(() => service.prepare(repo, repo)).toThrow("unavailable");
  });
  it("denies forged principals, foreign repository and child identities", () => {
    const { service, actor } = fixture();
    expect(() => {
      service.authorize({ ...actor }, repo);
    }).toThrow("unauthorized");
    expect(() => {
      service.authorize(actor, `${repo}-foreign`);
    }).toThrow("not_found");
    expect(() => {
      service.authorize(actor, repo, "foreign");
    }).toThrow("not_found");
    service.authorize(actor, repo, actor.terminalId);
    service.authorize(actor, repo);
    const child = service.prepare(repo, repo, "agent", actor.terminalId);
    child.bind("child");
    expect(service.authenticate(child.env["FOOM_CONTROL_TOKEN"] ?? "").parentId).toBe(
      actor.terminalId,
    );
  });
  it("bounds concurrent calls and releases reservations exactly once", () => {
    const { service, actor } = fixture();
    const releases = Array.from({ length: 4 }, () => service.reserve(actor));
    expect(() => service.reserve(actor)).toThrow("capacity");
    for (const release of releases) {
      release();
      release();
    }
    service.reserve(actor)();
  });
  it.each([
    null,
    [],
    1,
    "text",
    { version: 2 },
    { version: 1, instanceId: "stale", params: {} },
    { version: 1, force: true },
  ])("rejects malformed or stale envelope %j", (input) => {
    const { service, actor } = fixture();
    expect(() => service.dispatch(actor, input)).toThrow("invalid_request");
  });
  it("rejects unknown fields, role/force flags and all unshipped methods", () => {
    const { service, actor, request } = fixture();
    for (const params of [{ role: "orchestrator" }, { force: true }, null, []])
      expect(() => service.dispatch(actor, request("whoami", params))).toThrow("invalid_request");
    for (const method of ["launch", "reply", "stop", "unknown"])
      expect(() => service.dispatch(actor, request(method))).toThrow("forbidden");
    expect(() => service.prepare("relative", repo)).toThrow("invalid_request");
    expect(() => service.prepare(repo, `${repo}\0`)).toThrow("invalid_request");
    expect(() => identifier("a".repeat(201))).toThrow("invalid_request");
    expect(() => object(false)).toThrow(ControlError);
  });
});

describe("durable operations before effects", () => {
  it("deduplicates concurrent intent, supports both private selectors and rejects different inputs", async () => {
    const { operations, actor, persist, service, request } = fixture();
    const [first, second] = await Promise.all([
      operations.begin(actor, "stop", "key", "{}", "child"),
      operations.begin(actor, "stop", "key", "{}", "child"),
    ]);
    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });
    expect(persist).toHaveBeenCalledTimes(1);
    const { created, ...publicRecord } = first;
    expect(created).toBe(true);
    expect(operations.lookup(actor, { operationId: first.operationId })).toEqual(publicRecord);
    expect(service.dispatch(actor, request("operation_status", { idempotencyKey: "key" }))).toEqual(
      publicRecord,
    );
    await expect(operations.begin(actor, "stop", "key", "different", "child")).rejects.toThrow(
      "conflict",
    );
    const completed = await operations.finish(
      actor,
      first.operationId,
      "succeeded",
      "completed",
      "result",
    );
    expect(completed.status).toBe("succeeded");
    expect(await operations.begin(actor, "stop", "key", "{}", "child")).toEqual({
      ...completed,
      created: false,
    });
    await expect(operations.finish(actor, first.operationId, "failed", "error")).rejects.toThrow(
      "conflict",
    );
    expect(JSON.stringify(persist.mock.calls)).not.toContain('"key":"key"');
  });
  it.each(["succeeded", "failed", "declined", "cancelled", "indeterminate"] as const)(
    "preserves %s outcomes without replay",
    async (status) => {
      const { operations, actor } = fixture();
      const first = await operations.begin(
        actor,
        "remove_worktree",
        "key",
        "private prompt",
        null,
        true,
      );
      await operations.finish(actor, first.operationId, status, "completed");
      expect(operations.lookup(actor, { idempotencyKey: "key" }).status).toBe(status);
    },
  );
  it("rejects unknown/foreign selectors, malformed keys and exhausted storage", async () => {
    const { operations, actor, service } = fixture(1);
    const first = await operations.begin(actor, "launch", "key", "{}");
    for (const selector of [
      {},
      { operationId: "x", idempotencyKey: "y" },
      { idempotencyKey: "key", force: true },
      { operationId: 2 },
    ])
      expect(() => operations.lookup(actor, selector)).toThrow("invalid_request");
    expect(() => operations.lookup(actor, { operationId: "unknown" })).toThrow("not_found");
    const other = service.prepare(`${repo}-other`, repo, "orchestrator");
    other.bind("other");
    const foreign = service.authenticate(other.env["FOOM_CONTROL_TOKEN"] ?? "");
    expect(() => operations.lookup(foreign, { operationId: first.operationId })).toThrow(
      "not_found",
    );
    expect(() => operations.lookup(foreign, { idempotencyKey: "key" })).toThrow("not_found");
    await expect(
      operations.finish(foreign, first.operationId, "succeeded", "completed"),
    ).rejects.toThrow("not_found");
    await expect(operations.begin(actor, "launch", "new", "{}")).rejects.toThrow("capacity");
    await expect(operations.begin(actor, "launch", "bad key", "{}")).rejects.toThrow(
      "invalid_request",
    );
    await expect(operations.begin(actor, "launch", "new", "x".repeat(65537))).rejects.toThrow(
      "invalid_request",
    );
    const reader = service.prepare(repo, repo);
    reader.bind("reader");
    await expect(
      operations.begin(
        service.authenticate(reader.env["FOOM_CONTROL_TOKEN"] ?? ""),
        "launch",
        "new",
        "{}",
      ),
    ).rejects.toThrow("forbidden");
  });
  it("fails closed on audit errors, retains deduplication and never leaks raw errors or input", async () => {
    const { operations, actor, persist } = fixture();
    persist.mockRejectedValueOnce(new Error("SECRET"));
    await expect(operations.begin(actor, "reply", "key", "secret proposal")).rejects.toThrow(
      "unavailable",
    );
    expect(await operations.begin(actor, "reply", "key", "secret proposal")).toMatchObject({
      status: "indeterminate",
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(persist.mock.calls)).not.toContain("secret proposal");
  });
  it("rechecks revocation after disk and on lookups, including replacement generations", async () => {
    const { operations, actor, grant, persist, service } = fixture();
    persist.mockImplementationOnce(() => {
      grant.dispose();
      return Promise.resolve();
    });
    await expect(operations.begin(actor, "stop", "key", "{}")).rejects.toThrow("unauthorized");
    expect(() => operations.lookup(actor, { idempotencyKey: "key" })).toThrow("unauthorized");
    const next = service.prepare(repo, repo, "orchestrator");
    next.bind("terminal");
    expect(() =>
      operations.lookup(service.authenticate(next.env["FOOM_CONTROL_TOKEN"] ?? ""), {
        idempotencyKey: "key",
      }),
    ).toThrow("not_found");
  });
  it("makes confirmations main-only, identity-bound, single-use and revocable", async () => {
    const { operations, actor, grant } = fixture();
    const op = await operations.begin(actor, "remove_worktree", "key", "{}", "tree", true);
    const accept = operations.confirmation(actor, op.operationId, "tree identity + dirty hash");
    await expect(accept("changed", true)).rejects.toThrow("conflict");
    expect(await accept("tree identity + dirty hash", true)).toMatchObject({ status: "running" });
    await expect(accept("tree identity + dirty hash", true)).rejects.toThrow("conflict");
    expect(() => operations.confirmation(actor, op.operationId, "same")).toThrow("conflict");
    const declined = await operations.begin(actor, "remove_worktree", "decline", "{}", null, true);
    expect(
      await operations.confirmation(actor, declined.operationId, "same")("same", false),
    ).toMatchObject({ status: "declined" });
    const pending = await operations.begin(actor, "remove_worktree", "revoke", "{}", null, true);
    const callback = operations.confirmation(actor, pending.operationId, "same");
    grant.dispose();
    await expect(callback("same", true)).rejects.toThrow("unauthorized");
  });
});

it("shares hook correlation without sharing the credential or generation", () => {
  const { service } = fixture();
  const first = service.prepare(repo, repo, "agent", null, "hook-session");
  const second = service.prepare(repo, repo, "agent", null, "hook-session");
  first.bind("first");
  second.bind("second");
  expect(first.env["FOOM_SESSION"]).toBe("hook-session");
  const firstActor = service.authenticate(first.env["FOOM_CONTROL_TOKEN"] ?? "");
  const secondActor = service.authenticate(second.env["FOOM_CONTROL_TOKEN"] ?? "");
  expect(firstActor.sessionId).toBe("hook-session");
  expect(firstActor.generation).not.toBe(secondActor.generation);
  first.dispose();
  expect(service.authenticate(second.env["FOOM_CONTROL_TOKEN"] ?? "")).toBe(secondActor);
});
