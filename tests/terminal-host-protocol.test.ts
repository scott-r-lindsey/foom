import { expect, test } from "vitest";
import { hostRequest, hostResponse } from "../src/terminal-host-protocol";
const base = { id: "terminal", request: 1 };
const spec = { command: "bash", args: ["-l", ""], cwd: "/tmp", cols: 80, rows: 24 };
test("validates every request shape, dimensions, arguments and bounded values", () => {
  for (const value of [
    null,
    1,
    {},
    { ...base, id: "" },
    { ...base, id: "a\0b" },
    { ...base, id: "a".repeat(4097) },
    { ...base, request: 0 },
    { ...base, request: 1.5 },
    { ...base, request: Infinity },
    { ...base, type: "unknown" },
  ])
    expect(hostRequest(value)).toBe(false);
  for (const type of ["detach", "kill"]) expect(hostRequest({ ...base, type })).toBe(true);
  expect(hostRequest({ ...base, type: "attach", view: "view" })).toBe(true);
  expect(hostRequest({ ...base, type: "attach", view: null })).toBe(false);
  expect(hostRequest({ ...base, type: "create", spec })).toBe(true);
  for (const bad of [
    null,
    {},
    { ...spec, command: 1 },
    { ...spec, cwd: "" },
    { ...spec, args: null },
    { ...spec, args: Array.from({ length: 257 }, () => "a") },
    { ...spec, args: [1] },
    { ...spec, args: ["a\0b"] },
    { ...spec, args: ["a".repeat(65537)] },
    { ...spec, cols: 1 },
    { ...spec, cols: 501 },
    { ...spec, rows: 301 },
  ])
    expect(hostRequest({ ...base, type: "create", spec: bad })).toBe(false);
  for (const data of ["", "hello"])
    expect(hostRequest({ ...base, type: "write", data })).toBe(true);
  for (const data of [null, "x".repeat(65537)])
    expect(hostRequest({ ...base, type: "write", data })).toBe(false);
  expect(hostRequest({ ...base, type: "resize", cols: 80, rows: 24 })).toBe(true);
  expect(hostRequest({ ...base, type: "resize", cols: 80, rows: 1 })).toBe(false);
  expect(hostRequest({ ...base, type: "resize", cols: 0, rows: 24 })).toBe(false);
  expect(hostRequest({ ...base, type: "acknowledge", token: "view", count: 8 })).toBe(true);
  expect(hostRequest({ ...base, type: "acknowledge", token: null, count: 8 })).toBe(false);
  expect(hostRequest({ ...base, type: "acknowledge", token: "view", count: -1 })).toBe(false);
  expect(hostRequest({ ...base, type: "tail", lines: 40 })).toBe(true);
  expect(hostRequest({ ...base, type: "tail", lines: 10001 })).toBe(false);
});
test("rejects malformed host replies and events before main uses them", () => {
  for (const value of [
    null,
    {},
    { ...base, type: "unknown" },
    { ...base, id: 4, type: "exit", code: 0 },
  ])
    expect(hostResponse(value)).toBe(false);
  for (const type of ["result", "error"]) {
    expect(hostResponse({ ...base, type, lines: [] })).toBe(true);
    expect(hostResponse({ ...base, type, request: 0, lines: [] })).toBe(false);
  }
  for (const lines of [null, [1], Array.from({ length: 10001 }, () => "a")])
    expect(hostResponse({ ...base, type: "result", lines })).toBe(false);
  expect(hostResponse({ ...base, type: "data", view: "view", token: "view", data: "" })).toBe(true);
  expect(hostResponse({ ...base, type: "data", view: "view", token: null, data: "" })).toBe(false);
  expect(hostResponse({ ...base, type: "data", view: "view", token: "view", data: null })).toBe(
    false,
  );
  expect(hostResponse({ ...base, type: "exit", code: 0 })).toBe(true);
  expect(hostResponse({ ...base, type: "exit", code: NaN })).toBe(false);
});
