import type * as ManualModule from "../../../../src/main/control/manual";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { ControlService } from "../../../../src/main/control/service";
import { Operations } from "../../../../src/main/control/operations";
import { ControlError } from "../../../../src/shared/control-validation";
import {
  remotePublicResult,
  REMOTE_PHASE_2_REASON,
} from "../../../../src/shared/remote-agent-protocol";

const manual = vi.hoisted(() => ({
  text: "Offline manual",
  pause: undefined as Promise<void> | undefined,
}));
vi.mock("../../../../src/main/control/manual", async (original) => {
  const actual = await original<typeof ManualModule>();
  return {
    ...actual,
    bundledManual: () => new actual.Manual([{ id: "intro", heading: "Intro", text: manual.text }]),
  };
});
function fixture() {
  const child = randomUUID();
  const parent = randomUUID();
  const call = vi.fn(() =>
    Promise.resolve<unknown>({ seq: 1, status: "done", timestamp: "2026-10-24T00:00:00.000Z" }),
  );
  const service = new ControlService(
    new Operations(
      () => Promise.resolve(),
      (actor) => {
        service.assertActive(actor);
      },
    ),
    () => [],
    { call, canHandoff: () => true },
  );
  const grant = service.prepare(join(tmpdir(), "repo"), join(tmpdir(), "repo/wt"), "agent", parent);
  const remote = grant.remoteCall;
  if (!remote) throw new Error("Missing relay capability");
  return { service, grant, remote, child, parent, call };
}
test("all remote-facing result kinds omit hub terminal IDs, parent IDs and tokens; local whoami is unchanged", async () => {
  const f = fixture();
  f.grant.bind(f.child);
  const token = f.grant.env["FOOM_CONTROL_TOKEN"] ?? "";
  const actor = f.service.authenticate(token);
  const local = f.service.dispatch(actor, {
    version: 1,
    instanceId: f.service.instanceId,
    method: "whoami",
    params: {},
  });
  expect(local).toMatchObject({ terminalId: f.child, parentId: f.parent });
  const identity = await f.remote("whoami", {});
  expect(identity).toMatchObject({
    type: "identity",
    role: "child",
    capabilities: ["whoami", "manual", "handoff"],
  });
  expect(await f.remote("whoami", {})).toEqual(identity);
  const results = [
    identity,
    await f.remote("mcp_connected", {}),
    await f.remote("manual", {}),
    await f.remote("manual", { section: "intro" }),
    await f.remote("handoff", { status: "done", summary: "Report", idempotencyKey: "report" }),
  ];
  for (const method of [
    "sessions",
    "session_state",
    "open_preview",
    "list_previews",
    "close_preview",
    "launch",
    "create_worktree",
    "operation_status",
    "pair",
    "unknown",
  ]) {
    const result = await f.remote(method, { id: f.child, parentId: f.parent });
    expect(remotePublicResult(result)).toEqual({
      error: "phase_2_restricted",
      reason: REMOTE_PHASE_2_REASON,
    });
    results.push(result);
  }
  results.push(await f.remote("whoami", { role: "orchestrator", terminalId: f.child }));
  f.grant.dispose();
  results.push(await f.remote("whoami", {}));
  for (const result of results) {
    for (const secret of [f.child, f.parent, token, actor.generation, f.service.instanceId]) {
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(remotePublicResult(result))).not.toContain(secret);
    }
  }
  expect(f.call).toHaveBeenCalledTimes(1);
  f.service.close();
});
test("remote launch aliases differ across grants and unbound, parentless, elevated and revoked grants cannot borrow child authority", async () => {
  const f = fixture();
  expect(await f.remote("whoami", {})).toEqual({ type: "error", error: "unauthorized" });
  f.grant.bind(f.child);
  const first = await f.remote("whoami", {});
  const other = f.service.prepare(
    join(tmpdir(), "repo"),
    join(tmpdir(), "repo/wt"),
    "agent",
    f.parent,
  );
  other.bind(randomUUID());
  expect(await other.remoteCall?.("whoami", {})).not.toEqual(first);
  const parentless = f.service.prepare(join(tmpdir(), "repo"), join(tmpdir(), "repo/wt"));
  parentless.bind(randomUUID());
  expect(await parentless.remoteCall?.("whoami", {})).toEqual({
    type: "error",
    error: "no_parent",
  });
  f.service.setRole(f.child, "orchestrator");
  expect(await f.remote("handoff", {})).toEqual({ type: "error", error: "no_parent" });
  f.service.close();
  expect(await other.remoteCall?.("whoami", {})).toEqual({ type: "error", error: "unauthorized" });
});
test("service failures and unexpected fields produce fixed errors, never exception text or projected identities", async () => {
  const f = fixture();
  f.grant.bind(f.child);
  const spy = vi.spyOn(f.service, "call");
  for (const value of [
    undefined,
    { seq: 1, status: "done", timestamp: "2026-10-24T00:00:00.000Z", terminalId: f.child },
    { seq: 1, status: "done", timestamp: f.parent },
  ]) {
    spy.mockResolvedValueOnce(value);
    expect(await f.remote("handoff", {})).toEqual({ type: "error", error: "unavailable" });
  }
  for (const error of [
    new Error(f.child),
    new ControlError("forbidden"),
    new ControlError("no_parent"),
    new ControlError("invalid_request"),
  ]) {
    spy.mockRejectedValueOnce(error);
    const result = await f.remote("handoff", {});
    expect(result).toEqual({
      type: "error",
      error:
        error instanceof ControlError && ["no_parent", "invalid_request"].includes(error.code)
          ? error.code
          : "unavailable",
    });
  }
  manual.text = f.child;
  expect(await f.remote("manual", { section: "intro" })).toEqual({
    type: "error",
    error: "unavailable",
  });
  manual.text = "Offline manual";
  let resolve: (value: unknown) => void = () => {};
  spy.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = f.remote("handoff", {});
  f.grant.dispose();
  resolve({ seq: 1, status: "done", timestamp: "2026-10-24T00:00:00.000Z" });
  expect(await pending).toEqual({ type: "error", error: "unauthorized" });
  f.service.close();
});

test("takeover and loss of live child ownership refuse the entire remote surface", async () => {
  const f = fixture();
  f.grant.bind(f.child);
  vi.spyOn(f.service, "capabilities").mockReturnValue(["whoami", "manual"]);
  for (const method of ["whoami", "manual", "handoff", "sessions"])
    expect(await f.remote(method, {})).toEqual({ type: "error", error: "no_parent" });
  f.service.close();
});

test("validated MCP handshake reports connection status without exposing another tool or identity", async () => {
  const f = fixture();
  f.grant.bind(f.child, true);
  const connected = vi.spyOn(f.service, "mcpConnected");
  expect(await f.remote("mcp_connected", { terminalId: f.child })).toEqual({
    type: "error",
    error: "invalid_request",
  });
  expect(connected).not.toHaveBeenCalled();
  expect(await f.remote("mcp_connected", {})).toMatchObject({ type: "identity" });
  expect(connected).toHaveBeenCalledWith(expect.objectContaining({ terminalId: f.child }));
  f.service.close();
});
