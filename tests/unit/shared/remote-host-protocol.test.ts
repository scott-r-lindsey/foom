import { expect, test } from "vitest";
import {
  MAX_REMOTE_FRAME,
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
    { ...base, type: "open", cols: 0, rows: 24 },
    { ...base, id: "../x", type: "detach" },
  ])
    expect(remoteRequest(value)).toBe(false);
  expect(remoteRequest({ ...base, type: "open", cols: 80, rows: 24 })).toBe(true);
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
  for (const text of ["not json", "null", "{}", '{"version":2,"message":{}}', '{"version":1}']) {
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
