import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ControlService } from "../../../../src/main/control/service";
import { Operations } from "../../../../src/main/control/operations";
import { metadataName } from "../../../../src/main/control/metadata";
import type { WorkspaceTerminal } from "../../../../src/shared/workspace";
it("bounds and scopes metadata without leaking reasons, paths, credentials or output", () => {
  const repo = join(tmpdir(), "repo");
  const rows: WorkspaceTerminal[] = Array.from({ length: 102 }, (_, index) => ({
    id: `id${String(index)}`,
    agent: "claude",
    kind: "agent",
    repository: repo,
    worktree: repo,
    branch: "token=supersecret",
    attention: "evaluator",
    state: {
      id: `id${String(index)}`,
      verdictId: null,
      state: "needs_input",
      reason: "private output",
      signal: "private signal",
      timestamp: 123,
      confidence: 1,
    },
  }));
  const first = rows[0];
  if (!first) throw new Error("Missing fixture");
  rows.push({ ...first, id: "foreign", repository: join(tmpdir(), "foreign") });
  const service = new ControlService(
    new Operations(
      () => Promise.resolve(),
      () => undefined,
    ),
    () => rows,
  );
  const grant = service.prepare(repo, repo);
  grant.bind("terminal");
  const actor = service.authenticate(grant.env["FOOM_CONTROL_TOKEN"] ?? "");
  const call = (method: string, params: unknown = {}) =>
    service.dispatch(actor, { version: 1, instanceId: service.instanceId, method, params });
  const result = call("sessions");
  expect(result).toMatchObject({ nextCursor: "id99" });
  expect(call("session_state", { id: "id0" })).toMatchObject({
    name: "[REDACTED CREDENTIAL]",
    reason: "needs_input",
    attentionKind: "unknown",
  });
  expect(JSON.stringify(result)).not.toMatch(/supersecret|private output|private signal|foreign/u);
  expect(call("sessions", { cursor: "id99" })).toMatchObject({ nextCursor: null });
  expect(call("sessions", { limit: 1 })).toMatchObject({ nextCursor: "id0" });
  for (const params of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: "1" },
    { repository: repo },
  ])
    expect(() => call("sessions", params)).toThrow("invalid_request");
  for (const id of ["foreign", "missing"]) {
    expect(() => call("session_state", { id })).toThrow("not_found");
    expect(() => call("sessions", { cursor: id })).toThrow("not_found");
  }
  expect(call("session_state", { id: "id0" })).toMatchObject({ id: "id0" });
  first.exited = true;
  first.state = null;
  first.branch = null;
  expect(call("session_state", { id: "id0" })).toMatchObject({
    state: "exited",
    attentionKind: null,
  });
  first.exited = false;
  expect(call("session_state", { id: "id0" })).toMatchObject({ state: "quiet_ok" });
  expect(metadataName("x".repeat(4097))).toBe("[redacted]");
  expect(metadataName("word ".repeat(100))).toHaveLength(160);
  expect(metadataName("a\u202eb\nc")).toBe("a b c");
});
it("rechecks revocation during metadata collection", () => {
  const service = new ControlService(
    new Operations(
      () => Promise.resolve(),
      () => undefined,
    ),
    () => {
      grant.dispose();
      return [];
    },
  );
  const grant = service.prepare(tmpdir(), tmpdir());
  grant.bind("terminal");
  const actor = service.authenticate(grant.env["FOOM_CONTROL_TOKEN"] ?? "");
  expect(() =>
    service.dispatch(actor, {
      version: 1,
      instanceId: service.instanceId,
      method: "sessions",
      params: {},
    }),
  ).toThrow("unauthorized");
});

it("tracks current execution and changes revisions on relaunch, attention and exit", () => {
  const repo = tmpdir();
  const execution = {
    terminalId: "terminal",
    launch: 1,
    revision: 1,
    turn: 1,
    phase: "working" as const,
  };
  const row: WorkspaceTerminal = {
    id: "terminal",
    kind: "agent",
    agent: "codex",
    repository: repo,
    worktree: repo,
    branch: null,
    attention: "evaluator",
    execution,
    state: {
      id: "terminal",
      state: "done",
      execution: { ...execution, revision: 0 },
      timestamp: 1,
      verdictId: null,
      reason: "private",
      signal: "private",
      confidence: 1,
    },
  };
  const service = new ControlService(
    new Operations(
      () => Promise.resolve(),
      () => undefined,
    ),
    () => [row],
  );
  const grant = service.prepare(repo, repo);
  grant.bind("terminal");
  const actor = service.authenticate(grant.env["FOOM_CONTROL_TOKEN"] ?? "");
  const call = () =>
    service.dispatch(actor, {
      version: 1,
      instanceId: service.instanceId,
      method: "session_state",
      params: { id: "terminal" },
    });
  const working = call();
  expect(working).toMatchObject({ state: "working" });
  expect(call()).toEqual(working);
  row.execution = { ...execution, phase: "blocked", revision: 2 };
  expect(call()).toMatchObject({ state: "needs_input" });
  expect(call()).not.toEqual(working);
  row.execution = { ...execution, phase: "idle" };
  expect(call()).toMatchObject({ state: "quiet_ok" });
  if (!row.state) throw new Error("Expected verdict");
  row.state = { ...row.state, execution: row.execution, state: "working" };
  expect(call()).toMatchObject({ state: "quiet_ok" });
  row.state.state = "checking";
  expect(call()).toMatchObject({ state: "quiet_ok" });
  row.state.state = "done";
  expect(call()).toMatchObject({ state: "done" });
  row.execution = { ...row.execution, phase: "starting" };
  expect(call()).toMatchObject({ state: "done" });
  row.exited = true;
  expect(call()).toMatchObject({ state: "exited" });
});
