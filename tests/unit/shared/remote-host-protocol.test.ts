import { expect, test } from "vitest";
import {
  MAX_REMOTE_FRAME,
  MAX_REMOTE_MESSAGE,
  REMOTE_FRAGMENT_SIZE,
  RemoteMessages,
  remoteResponseFrames,
  RemoteFrames,
  remoteFrame,
  remoteHost,
  remoteId,
  remoteRequest,
  remoteResponse,
} from "../../../src/shared/remote-host-protocol";

test("SSH destinations reject options, shell syntax, URI and control characters", () => {
  for (const host of ["vm", "user@vm.example", "127.0.0.1", "my-cloud_alias"])
    expect(remoteHost(host)).toBe(true);
  for (const host of [
    undefined,
    "",
    "-oProxyCommand=touch",
    "-Fconfig",
    "user@-host",
    "vm -oProxyCommand=x",
    "vm;touch x",
    "$(id)",
    "`id`",
    "vm\nnext",
    "ssh://vm",
    "u@@vm",
    "a".repeat(254),
    "[::1]",
  ])
    expect(remoteHost(host)).toBe(false);
  expect(remoteId("one_2-3")).toBe(true);
  for (const id of [null, "", "../session", "a".repeat(201)]) expect(remoteId(id)).toBe(false);
});

test("only shell operations and runtime-validated responses cross the remote boundary", () => {
  const base = { id: "one", request: 1 };
  const hello = { type: "hello", build: "a".repeat(64) };
  expect(remoteRequest(hello)).toBe(true);
  expect(remoteResponse(hello)).toBe(true);
  for (const value of [
    null,
    false,
    {},
    { type: "hello", build: "bad" },
    { ...base, type: "create" },
    { ...base, type: "shutdown" },
    { ...base, type: "child-input" },
    { ...base, type: "open", reattach: false, cols: 0, rows: 24 },
    { ...base, id: "../x", type: "detach" },
  ])
    expect(remoteRequest(value)).toBe(false);
  expect(remoteRequest({ ...base, type: "open", reattach: false, cols: 80, rows: 24 })).toBe(true);
  expect(remoteRequest({ ...base, type: "write", data: "x" })).toBe(true);
  for (const value of [
    null,
    {},
    { type: "exit", id: "../x", code: 0 },
    { type: "activity", entries: Array.from({ length: 33 }, () => ({ id: "x", rate: 1 })) },
    { type: "activity", entries: [{ id: "../x", rate: 1 }] },
  ])
    expect(remoteResponse(value)).toBe(false);
  expect(remoteResponse({ type: "exit", id: "one", code: 0 })).toBe(true);
  expect(remoteResponse({ type: "activity", entries: [{ id: "one", rate: 0 }] })).toBe(true);
});

test("frames survive arbitrary fragmentation and coalescing without exceeding the length cap", () => {
  const message = { type: "write", request: 1, id: "one", data: "λ\u001b[31m🙂" } as const;
  const frame = remoteFrame(message);
  const received: unknown[] = [];
  const decoder = new RemoteFrames();
  for (const byte of frame) decoder.push(Uint8Array.of(byte), (value) => received.push(value));
  decoder.end();
  const combined = new Uint8Array(frame.length * 2);
  combined.set(frame);
  combined.set(frame, frame.length);
  decoder.push(combined, (value) => received.push(value));
  expect(received).toEqual([message, message, message]);
  for (const size of [0, MAX_REMOTE_FRAME + 1]) {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, size);
    expect(() => {
      new RemoteFrames().push(header, () => {});
    }).toThrow("length");
  }
  expect(() => remoteFrame({ ...message, data: "x".repeat(MAX_REMOTE_FRAME) })).toThrow("large");
  for (const part of [frame.subarray(0, 1), frame.subarray(0, 5)]) {
    const reader = new RemoteFrames();
    reader.push(part, () => {});
    expect(() => {
      reader.end();
    }).toThrow("Truncated");
  }
  for (const text of ["not json", "null", "{}", '{"version":1,"message":{}}', '{"version":1}']) {
    const body = new TextEncoder().encode(text);
    const bytes = new Uint8Array(body.length + 4);
    new DataView(bytes.buffer).setUint32(0, body.length);
    bytes.set(body, 4);
    expect(() => {
      new RemoteFrames().push(bytes, () => {});
    }).toThrow();
  }
  expect(() => {
    new RemoteFrames().push(Uint8Array.of(0, 0, 0, 1, 255), () => {});
  }).toThrow();
});

test("ANSI-rich retained screens larger than a frame reassemble exactly through bounded frames", async () => {
  const { Terminal } = await import("@xterm/headless");
  const { SerializeAddon } = await import("@xterm/addon-serialize");
  const screen = new Terminal({ cols: 80, rows: 24, scrollback: 10000, allowProposedApi: true });
  const serializer = new SerializeAddon();
  screen.loadAddon(serializer);
  try {
    await new Promise<void>((resolve) => {
      screen.write(("\x1b[31mA\x1b[32mB".repeat(40) + "\r\n").repeat(10000), resolve);
    });
    const message = {
      type: "data",
      id: "one",
      view: "v",
      token: "t",
      data: "\x1bc" + serializer.serialize(),
    } as const;
    expect(() => remoteFrame(message)).toThrow("large");
    const frames = new RemoteFrames();
    const responses = new RemoteMessages();
    const received: unknown[] = [];
    let count = 0;
    for (const frame of remoteResponseFrames(message)) {
      count++;
      expect(frame.length - 4).toBeLessThanOrEqual(MAX_REMOTE_FRAME);
      frames.push(frame, (wire) => {
        expect(remoteResponse(wire)).toBe(true);
        if (!remoteResponse(wire)) throw new Error("Invalid wire response");
        const response = responses.push(wire);
        if (response) received.push(response);
      });
    }
    expect(count).toBeGreaterThan(1);
    expect(received).toEqual([message]);
  } finally {
    screen.dispose();
  }
});

test("reassembly rejects excessive totals, gaps, mismatched identity, interleaving and nested payloads", () => {
  const first = {
    type: "fragment",
    id: "one",
    offset: 0,
    total: REMOTE_FRAGMENT_SIZE + 1,
    data: "x".repeat(REMOTE_FRAGMENT_SIZE),
  } as const;
  for (const invalid of [
    { ...first, total: MAX_REMOTE_MESSAGE + 1 },
    { ...first, total: 0 },
    { ...first, offset: -1 },
    { ...first, data: "" },
  ]) {
    expect(remoteResponse(invalid)).toBe(false);
    expect(() => new RemoteMessages().push(invalid)).toThrow("fragment");
  }
  for (const next of [
    { ...first, offset: 1 },
    { ...first, id: "two" },
    { ...first, total: first.total + 1 },
    { type: "exit", id: "one", code: 0 },
  ] as const) {
    const messages = new RemoteMessages();
    messages.push(first);
    expect(() => messages.push(next)).toThrow();
  }
  expect(() => new RemoteMessages().push({ ...first, offset: 1 })).toThrow("Noncontiguous");
  for (const value of [
    "not json",
    JSON.stringify({ type: "fragment", id: "one" }),
    JSON.stringify({ type: "exit", id: "two", code: 0 }),
  ])
    expect(() =>
      new RemoteMessages().push({
        type: "fragment",
        id: "one",
        offset: 0,
        total: value.length,
        data: value,
      }),
    ).toThrow();
  expect(() => [
    ...remoteResponseFrames({
      type: "data",
      id: "one",
      view: "v",
      token: "t",
      data: "x".repeat(MAX_REMOTE_MESSAGE),
    }),
  ]).toThrow("large");
});

test("open intent is a required boolean and terminal outcomes are typed and validated", () => {
  const open = { type: "open", id: "one", request: 1, cols: 80, rows: 24 };
  for (const reattach of [false, true]) expect(remoteRequest({ ...open, reattach })).toBe(true);
  for (const reattach of [undefined, null, "true", 1, {}, []])
    expect(remoteRequest({ ...open, reattach })).toBe(false);
  const base = { type: "open-result", id: "one", request: 1 };
  for (const outcome of [
    { state: "live" },
    { state: "gone" },
    { state: "exited", code: 0 },
    { state: "exited", code: 7 },
  ])
    expect(remoteResponse({ ...base, ...outcome })).toBe(true);
  for (const invalid of [
    base,
    { ...base, id: "../bad", state: "gone" },
    { ...base, request: 0, state: "gone" },
    { ...base, state: "unknown" },
    { ...base, state: "exited" },
    { ...base, state: "exited", code: NaN },
    { ...base, state: "exited", code: "0" },
    { ...base, state: "gone", code: 0 },
    { ...base, state: "live", code: 0 },
  ])
    expect(remoteResponse(invalid)).toBe(false);
});

test("a reassembled open outcome is validated as a remote response", () => {
  const outcome = { type: "open-result", id: "one", request: 1, state: "exited", code: 7 };
  const data = JSON.stringify(outcome);
  expect(
    new RemoteMessages().push({ type: "fragment", id: "one", offset: 0, total: data.length, data }),
  ).toEqual(outcome);
});

test("agent failures are a fixed enum and cleanup requests cannot carry commands or extra fields", () => {
  expect(remoteRequest({ type: "agent-close", id: "child", request: 1 })).toBe(true);
  for (const value of [
    { type: "agent-close", id: "child", request: 1, command: "arbitrary" },
    { type: "agent-close", id: "child", request: -1 },
    { type: "agent-close", id: "../child", request: 1 },
    { type: "agent-close", id: "child" },
  ])
    expect(remoteRequest(value)).toBe(false);
  expect(
    remoteResponse({ type: "agent-failed", id: "child", reason: "remote_agent_unavailable" }),
  ).toBe(true);
  for (const value of [
    { type: "agent-failed", id: "child", reason: "private stderr" },
    { type: "agent-failed", id: "child", reason: "remote_prepare_refused", stderr: "private" },
    { type: "agent-failed", id: "child" },
  ])
    expect(remoteResponse(value)).toBe(false);
});

test("profile inventory and confirmed cleanup are closed, bounded and incarnation-scoped", () => {
  const profile = "a".repeat(32);
  const foreign = { id: "other", generation: "b".repeat(32) };
  const context = { repository: "/repo", worktree: "/tree", branch: "topic", agent: "claude" };
  const request = { type: "open", id: "one", request: 1, cols: 80, rows: 24, reattach: true };
  expect(remoteRequest({ ...request, profile, context, human: true })).toBe(true);
  expect(remoteRequest({ type: "inventory", profile })).toBe(true);
  expect(remoteRequest({ type: "end-sessions", profile, ids: [foreign] })).toBe(true);
  expect(
    remoteResponse({
      type: "inventory-result",
      own: [
        {
          id: "one",
          context,
          checkout: { repository: "/repo", path: "/tree", identity: "c".repeat(64) },
        },
      ],
      foreign: [foreign],
    }),
  ).toBe(true);
  expect(remoteResponse({ type: "hello", build: "a".repeat(64), compatible: 2 })).toBe(true);
  expect(remoteResponse({ type: "hello", build: "a".repeat(64), compatible: 3 })).toBe(false);
  expect(remoteResponse({ type: "upgrade", build: "a".repeat(64) })).toBe(true);
  for (const value of [undefined, null, 0, "short", "z".repeat(32)]) {
    expect(remoteRequest({ type: "inventory", profile: value })).toBe(false);
    if (value !== undefined) expect(remoteRequest({ ...request, profile: value })).toBe(false);
  }
  for (const value of [
    null,
    {},
    { ...context, repository: "relative" },
    { ...context, worktree: "relative" },
    { ...context, branch: "bad\nbranch" },
    { ...context, agent: "-x" },
  ])
    expect(remoteRequest({ ...request, context: value })).toBe(false);
  expect(remoteRequest({ ...request, context: { ...context, branch: null } })).toBe(true);
  expect(remoteRequest({ ...request, human: "yes" })).toBe(false);
  for (const ids of [
    null,
    [foreign, foreign],
    [{ id: "other" }],
    [{ ...foreign, generation: "bad" }],
    Array.from({ length: 34 }, () => foreign),
  ])
    expect(remoteRequest({ type: "end-sessions", profile, ids })).toBe(false);
  for (const changed of [
    { own: [{ id: "one" }, { id: "one" }], foreign: [] },
    { own: [{ id: "other" }], foreign: [foreign] },
    { own: [], foreign: [{ id: "other", generation: "bad" }] },
    { own: [{ id: "one", context: {} }], foreign: [] },
    { own: [{ id: "one", checkout: {} }], foreign: [] },
    { own: [], foreign: Array.from({ length: 34 }, () => foreign) },
    { own: null, foreign: [] },
    { own: [], foreign: null },
  ])
    expect(remoteResponse({ type: "inventory-result", ...changed })).toBe(false);
});

test("session cleanup is terminal-ID and profile scoped", () => {
  const message = { type: "session-close", id: "one", request: 1, profile: "a".repeat(32) };
  expect(remoteRequest(message)).toBe(true);
  for (const changed of [
    { ...message, profile: "bad" },
    { ...message, id: "../foreign" },
    { ...message, request: -1 },
    { ...message, force: true },
  ])
    expect(remoteRequest(changed)).toBe(false);
});
