import { expect, test } from "vitest";
import { cleanTitle, isAgentEvidence, parseProgress } from "../../../src/shared/agent-evidence";
import { hostResponse } from "../../../src/shared/terminal-host-protocol";
test("titles are capped and control/format characters are removed", () => {
  expect(cleanTitle("\0\x1b\n\t\u202eAction Required")).toBe("Action Required");
  expect(cleanTitle("x".repeat(1000))).toHaveLength(512);
});
test.each(["4;0", "4;1;50", "4;2;100", "4;3", "4;4;0"])("progress parses %s", (data) => {
  expect(parseProgress(data)?.state).toBe(Number(data.split(";")[1]));
});
test.each([
  "4;0;101",
  "4;5",
  "4;-1",
  "4;1;1.5",
  "4;1;9999",
  "hello",
  "4;0;",
  "4;0;0;other",
  "4;0\n",
])("rejects malformed progress %s", (data) => {
  expect(parseProgress(data)).toBeNull();
});
test("only bounded, sanitized metadata crosses the host boundary", () => {
  expect(isAgentEvidence({ title: "hi", progress: null })).toBe(true);
  expect(isAgentEvidence({ title: "", progress: { state: 0, value: null } })).toBe(true);
  expect(isAgentEvidence({ title: "", progress: { state: 4, value: 100 } })).toBe(true);
  for (const value of [
    null,
    "x",
    {},
    { title: 1 },
    { title: "\x1b" },
    { title: "x".repeat(513) },
    { title: "x" },
    ...[
      undefined,
      {},
      "bad",
      { state: -1, value: 0 },
      { state: 5, value: 0 },
      { state: 1.1, value: 0 },
      { state: 1, value: -1 },
      { state: 1, value: 101 },
      { state: 1, value: "0" },
      { state: "1", value: 0 },
    ].map((progress) => ({ title: "", progress })),
  ]) {
    expect(isAgentEvidence(value)).toBe(false);
    expect(hostResponse({ type: "evidence", id: "t", evidence: value })).toBe(false);
  }
  expect(
    hostResponse({ type: "evidence", id: "t", evidence: { title: "codex", progress: null } }),
  ).toBe(true);
});
