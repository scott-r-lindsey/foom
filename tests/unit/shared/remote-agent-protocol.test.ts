import { expect, test } from "vitest";
import {
  remoteAgentSpec,
  remoteAgentReady,
  remoteControlResult,
  remoteHook,
  remotePublicResult,
  remotePath,
  record,
  keys,
} from "../../../src/shared/remote-agent-protocol";
import {
  remoteRequest,
  remoteResponse,
  RemoteFrames,
  remoteFrame,
} from "../../../src/shared/remote-host-protocol";

const spec = {
  agent: "claude",
  repository: "/repo",
  worktree: "/worktree",
  defaults: [],
  hooks: true,
};
const identity = {
  type: "identity",
  alias: "11111111-1111-4111-8111-111111111111",
  role: "child",
  capabilities: ["whoami", "manual", "handoff"],
};
const signal = {
  terminalId: "hub-secret",
  action: "working",
  signal: "plugin:claude:prompt",
  channel: "lifecycle",
  caseId: "prompt",
  conversationId: "conversation",
};
test("agent launch requests admit bounded literal data and reject unknown capabilities, invalid paths, arguments and prompts", () => {
  expect(remoteAgentSpec(spec)).toBe(true);
  expect(
    remoteAgentSpec({ ...spec, prompt: "Task\nsecond line", conversationId: "conversation" }),
  ).toBe(true);
  for (const value of [
    null,
    [],
    {},
    { ...spec, agent: "../claude" },
    { ...spec, hooks: 1 },
    { ...spec, terminalId: "id" },
    { ...spec, defaults: "--help" },
    { ...spec, defaults: [null] },
    { ...spec, defaults: ["x".repeat(20481)] },
    { ...spec, defaults: Array(257).fill("a") },
    { ...spec, defaults: Array(10).fill("x".repeat(10000)) },
    { ...spec, prompt: "" },
    { ...spec, prompt: " -flag" },
    { ...spec, prompt: "\0" },
    { ...spec, prompt: "x".repeat(16385) },
    { ...spec, conversationId: "../bad" },
    { ...spec, repository: "relative" },
    { ...spec, worktree: "/a/../b" },
  ])
    expect(remoteAgentSpec(value)).toBe(false);
  for (const value of [null, 1, "/a/./b", "/a\nb", "relative", "x".repeat(4097)])
    expect(remotePath(value)).toBe(false);
  expect(record([])).toBe(false);
  expect(keys({ extra: true }, [])).toBe(false);
  expect(remoteAgentReady({ hooks: false, mcp: false })).toBe(true);
  expect(
    remoteAgentReady({
      hooks: true,
      mcp: true,
      channels: ["lifecycle"],
      conversationId: "conversation",
    }),
  ).toBe(true);
  for (const value of [
    null,
    {},
    { hooks: 1, mcp: false },
    { hooks: false, mcp: 1 },
    { hooks: false, mcp: false, channels: "bad" },
    { hooks: false, mcp: false, channels: Array(17).fill("id") },
    { hooks: false, mcp: false, channels: [1] },
    { hooks: false, mcp: false, conversationId: "/bad" },
    { hooks: false, mcp: false, extra: true },
  ])
    expect(remoteAgentReady(value)).toBe(false);
});
test("reduced hooks carry only typed evidence and reject raw payloads or invalid normalization", () => {
  expect(remoteHook(signal)).toBe(true);
  expect(
    remoteHook({
      ...signal,
      endsTurn: false,
      recoverTurn: true,
      fullyIdle: false,
      terminationReason: "error",
    }),
  ).toBe(true);
  for (const field of [
    "terminalId",
    "action",
    "signal",
    "channel",
    "caseId",
    "conversationId",
    "endsTurn",
    "recoverTurn",
    "fullyIdle",
    "terminationReason",
  ])
    expect(remoteHook({ ...signal, [field]: null })).toBe(false);
  for (const value of [
    null,
    {},
    { ...signal, payload: { message: "secret" } },
    { ...signal, signal: "claude:Stop" },
    { ...signal, conversationId: "../path" },
  ])
    expect(remoteHook(value)).toBe(false);
});
test("remote result schema is exact, bounded and finite, including manual pages and fixed failures", () => {
  const handoff = {
    type: "handoff",
    seq: 1,
    status: "done",
    timestamp: "2026-10-24T00:00:00.000Z",
  };
  const sections = {
    type: "manual",
    value: { sections: [{ id: "intro", title: "Intro", summary: "Reference" }] },
  };
  const page = {
    type: "manual",
    value: { id: "intro", title: "Intro", text: "Reference\ntext", page: 0, nextPage: 1 },
  };
  for (const value of [
    identity,
    handoff,
    sections,
    page,
    { ...page, value: { id: "intro", title: "Intro", text: "", page: 0 } },
  ])
    expect(remoteControlResult(value)).toBe(true);
  for (const error of [
    "phase_2_restricted",
    "unavailable",
    "invalid_request",
    "unauthorized",
    "no_parent",
  ]) {
    const result = { type: "error", error };
    expect(remoteControlResult(result)).toBe(true);
  }
  for (const value of [
    null,
    {},
    { type: "unknown" },
    { ...identity, terminalId: "secret" },
    { ...identity, alias: "bad" },
    { ...identity, role: "orchestrator" },
    { ...identity, capabilities: ["whoami", "manual", "launch"] },
    { ...identity, capabilities: ["whoami", "whoami", "manual"] },
    { ...identity, capabilities: "whoami" },
    { ...identity, capabilities: [] },
    { ...handoff, seq: 0 },
    { ...handoff, status: "unknown" },
    { ...handoff, timestamp: "bad" },
    { ...handoff, terminalId: "secret" },
    { type: "error", error: "arbitrary text" },
    { type: "manual", value: null },
    { type: "manual", value: { sections: [null] } },
    { type: "manual", value: { sections: "bad" } },
    { type: "manual", value: { sections: Array(101).fill({}) } },
    { type: "manual", value: { sections: [{ id: "i", title: "t", summary: "s", extra: 1 }] } },
    { ...page, extra: 1 },
    { ...page, value: { id: "i", title: "t", text: "x".repeat(4097), page: 0 } },
    { ...page, value: { id: "i", title: "t", text: "x", page: -1 } },
    { ...page, value: { id: "i", title: "t", text: "x", page: 0, nextPage: 0 } },
    {
      type: "manual",
      value: {
        sections: Array(100).fill({
          id: "💡".repeat(100),
          title: "💡".repeat(100),
          summary: "💡".repeat(80),
        }),
      },
    },
  ])
    expect(remoteControlResult(value)).toBe(false);
  if (!remoteControlResult(identity) || !remoteControlResult(handoff) || !remoteControlResult(page))
    throw new Error("Invalid fixture");
  expect(remotePublicResult(identity)).toEqual({
    alias: identity.alias,
    role: "child",
    capabilities: identity.capabilities,
  });
  expect(remotePublicResult(handoff)).toEqual({
    seq: 1,
    status: "done",
    timestamp: handoff.timestamp,
  });
  expect(remotePublicResult(page)).toEqual(page.value);
  expect(remotePublicResult({ type: "error", error: "unavailable" })).toEqual({
    error: "unavailable",
  });
});
test("versioned wire additions reject foreign IDs, unknown fields and oversized relay payloads on both ends", () => {
  const open = { type: "agent-open", id: "secret", request: 1, cols: 80, rows: 24, spec };
  expect(remoteRequest(open)).toBe(true);
  expect(remoteRequest({ ...open, spec: { ...spec, command: "hub-executable" } })).toBe(false);
  expect(remoteRequest({ ...open, extra: true })).toBe(false);
  const call = { type: "agent-call", id: "secret", call: 1, method: "whoami", params: {} };
  expect(remoteResponse(call)).toBe(true);
  for (const value of [
    { ...call, call: 0 },
    { ...call, method: "x".repeat(65) },
    { ...call, params: [] },
    { ...call, params: { x: "x".repeat(65537) } },
    { ...call, extra: true },
  ])
    expect(remoteResponse(value)).toBe(false);
  expect(remoteResponse({ type: "agent-hook", id: "hub-secret", signal })).toBe(true);
  expect(remoteResponse({ type: "agent-hook", id: "other", signal })).toBe(false);
  expect(
    remoteResponse({ type: "agent-ready", id: "secret", ready: { hooks: false, mcp: false } }),
  ).toBe(true);
  expect(remoteRequest({ type: "agent-reply", id: "secret", call: 1, result: identity })).toBe(
    true,
  );
  for (const value of [
    { type: "agent-reply", id: "secret", call: 0, result: identity },
    { type: "agent-reply", id: "secret", call: 1, result: { ...identity, terminalId: "secret" } },
  ])
    expect(remoteRequest(value)).toBe(false);
  const messages: unknown[] = [];
  if (!remoteRequest(open)) throw new Error("Invalid open fixture");
  new RemoteFrames().push(remoteFrame(open), (value) => messages.push(value));
  expect(messages).toEqual([open]);
});

test("tool params are validated on the host with the same handoff/review contract before relay", async () => {
  const { remoteControlParams } = await import("../../../src/shared/remote-agent-protocol");
  expect(
    remoteControlParams("handoff", {
      status: "done",
      summary: "Report",
      idempotencyKey: "report",
      review: { verdict: "clean" },
    }),
  ).toEqual({
    status: "done",
    summary: "Report",
    idempotencyKey: "report",
    review: { verdict: "clean" },
    links: [],
  });
  expect(remoteControlParams("manual", {})).toEqual({});
  expect(remoteControlParams("manual", { section: "intro", page: 0 })).toEqual({
    section: "intro",
    page: 0,
  });
  expect(remoteControlParams("sessions", { id: "opaque" })).toEqual({ id: "opaque" });
  for (const [method, params] of [
    ["whoami", { role: "orchestrator" }],
    ["manual", { section: "" }],
    ["manual", { section: 1 }],
    ["manual", { page: 0 }],
    ["manual", { section: "intro", page: -1 }],
    ["manual", { section: "intro", page: 0.5 }],
    ["manual", { section: "intro", page: "0" }],
    ["manual", { path: "/hub/file" }],
    [
      "handoff",
      { status: "done", summary: "report", parentId: "parent", idempotencyKey: "report" },
    ],
    [
      "handoff",
      {
        status: "blocked",
        summary: "report",
        review: { verdict: "clean" },
        idempotencyKey: "report",
      },
    ],
  ] as const)
    expect(() => remoteControlParams(method, params)).toThrow("invalid_request");
});
