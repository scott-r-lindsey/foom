import { launchReasons } from "../../../../src/shared/launch-failure";
import { removalReasons } from "../../../../src/main/workspace/worktree-outcome";
import { locationId, metadataName } from "../../../../src/main/control/metadata";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { ControlService } from "../../../../src/main/control/service";
import { Operations } from "../../../../src/main/control/operations";
import { ControlError, identifier, object } from "../../../../src/shared/control-validation";
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
      removalReasons,
      launchReasons,
      tools: [
        { name: "whoami", cli: "foom whoami" },
        { name: "sessions", cli: "foom sessions" },
        { name: "session_state", cli: "foom session-state" },
        { name: "manual" },
        { name: "open_preview", cli: "foom open-preview" },
        { name: "list_previews", cli: "foom previews" },
        { name: "close_preview", cli: "foom close-preview" },
        { name: "operation_status", cli: "foom operation-status" },
      ],
      capabilities: [
        "whoami",
        "sessions",
        "session_state",
        "manual",
        "open_preview",
        "list_previews",
        "close_preview",
        "operation_status",
      ],
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
      capabilities: [
        "whoami",
        "sessions",
        "session_state",
        "manual",
        "open_preview",
        "list_previews",
        "close_preview",
      ],
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

it("the human's role change keeps the token, replaces the principal and revokes its operations", async () => {
  const { service, operations, actor, token, request } = fixture();
  const pending = await operations.begin(actor, "stop", "key", "[]");
  expect(service.live(actor.generation)).toBe(true);
  service.setRole("terminal", "orchestrator");
  expect(service.authenticate(token)).toBe(actor);
  service.setRole("terminal", "agent");
  const agent = service.authenticate(token);
  expect(agent).toMatchObject({ generation: actor.generation, role: "agent", parentId: null });
  expect(Object.isFrozen(agent)).toBe(true);
  // The old principal stops working, and its in-flight operation needs reconciliation.
  expect(() => service.dispatch(actor, request("whoami"))).toThrow("unauthorized");
  expect(service.live(actor.generation)).toBe(true);
  expect(() => operations.lookup(agent, { operationId: pending.operationId })).toThrow("forbidden");
  service.setRole("terminal", "orchestrator");
  const again = service.authenticate(token);
  expect(operations.lookup(again, { operationId: pending.operationId })).toMatchObject({
    status: "indeterminate",
    reason: "uncertain",
  });
  expect(service.capabilities(again)).toContain("operation_status");
  expect(service.listed(agent)).toEqual(service.capabilities(again));
  // Pairing grants are never sessions, and a child's parent link ends with the change.
  const cli = service.grantCli(repo);
  expect(service.listed(service.authenticate(cli.token))).toEqual(
    service.capabilities(service.authenticate(cli.token)),
  );
  const child = service.prepare(repo, repo, "agent", "terminal");
  child.bind("child");
  service.setRole("child", "orchestrator");
  expect(service.authenticate(child.env["FOOM_CONTROL_TOKEN"] ?? "").parentId).toBeNull();
  expect(() => {
    service.setRole("missing", "orchestrator");
  }).toThrow("not_found");
  expect(() => {
    service.setRole("bad id", "agent");
  }).toThrow("invalid_request");
  expect(service.live("unknown")).toBe(false);
  service.close();
  expect(service.live(actor.generation)).toBe(false);
  expect(() => {
    service.setRole("terminal", "agent");
  }).toThrow("unavailable");
});

it("returns only live owned removals to review, with durable intent and no resurrection", async () => {
  const { operations, actor, persist, service } = fixture();
  const pending = await operations.begin(actor, "remove_worktree", "pending", "{}", "tree", true);
  expect(await operations.reviewRemoval(actor, pending.operationId)).toMatchObject({
    status: "pending_confirmation",
  });
  const running = await operations.begin(actor, "remove_worktree", "running", "{}", "tree");
  expect(await operations.reviewRemoval(actor, running.operationId)).toMatchObject({
    status: "pending_confirmation",
    resultId: null,
  });
  expect(persist).toHaveBeenLastCalledWith(
    expect.objectContaining({
      operation: expect.objectContaining({
        status: "pending_confirmation",
        reason: "intent",
      }) as unknown,
    }),
  );
  await operations.confirmation(actor, running.operationId, "identity")("identity", true);
  await operations.finish(actor, running.operationId, "succeeded", "completed");
  await expect(operations.reviewRemoval(actor, running.operationId)).rejects.toThrow("conflict");
  const launch = await operations.begin(actor, "launch", "launch", "{}");
  await expect(operations.reviewRemoval(actor, launch.operationId)).rejects.toThrow("conflict");
  await expect(operations.reviewRemoval(actor, "missing")).rejects.toThrow("not_found");
  const foreign = service.prepare(`${repo}-other`, repo, "orchestrator");
  foreign.bind("foreign");
  await expect(
    operations.reviewRemoval(
      service.authenticate(foreign.env["FOOM_CONTROL_TOKEN"] ?? ""),
      pending.operationId,
    ),
  ).rejects.toThrow("not_found");
  const failing = await operations.begin(actor, "remove_worktree", "failing", "{}");
  persist.mockRejectedValueOnce(new Error("disk full"));
  await expect(operations.reviewRemoval(actor, failing.operationId)).rejects.toThrow("unavailable");
  expect(operations.lookup(actor, { operationId: failing.operationId }).status).toBe(
    "indeterminate",
  );
});

it("dates the current role at binding and each change, preserving it on no-ops", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-10-15T01:00:00.000Z"));
    const { service, actor, token, request } = fixture();
    expect(service.dispatch(actor, request("whoami"))).toMatchObject({
      grantedAt: "2026-10-15T01:00:00.000Z",
    });
    const launch = service.prepare(repo, repo);
    vi.setSystemTime(new Date("2026-10-15T02:00:00.000Z"));
    launch.bind("later");
    const later = service.authenticate(launch.env["FOOM_CONTROL_TOKEN"] ?? "");
    expect(service.dispatch(later, request("whoami"))).toMatchObject({
      role: "agent",
      grantedAt: "2026-10-15T02:00:00.000Z",
    });
    service.setRole("terminal", "orchestrator");
    expect(service.authenticate(token).grantedAt).toBe(actor.grantedAt);
    service.setRole("terminal", "agent");
    expect(service.authenticate(token).grantedAt).toBe("2026-10-15T02:00:00.000Z");
    vi.setSystemTime(new Date("2026-10-15T03:00:00.000Z"));
    service.setRole("terminal", "orchestrator");
    expect(service.dispatch(service.authenticate(token), request("whoami"))).toMatchObject({
      role: "orchestrator",
      grantedAt: "2026-10-15T03:00:00.000Z",
    });
    const cli = service.grantCli(repo);
    expect(() => service.dispatch(service.authenticate(cli.token), request("manual"))).toThrow(
      "forbidden",
    );
    expect(service.dispatch(service.authenticate(cli.token), request("whoami"))).toMatchObject({
      role: "cli",
      grantedAt: "2026-10-15T03:00:00.000Z",
      tools: [
        { name: "whoami", cli: "foom whoami" },
        { name: "sessions", cli: "foom sessions" },
        { name: "session_state", cli: "foom session-state" },
      ],
    });
    service.close();
  } finally {
    vi.useRealTimers();
  }
});
