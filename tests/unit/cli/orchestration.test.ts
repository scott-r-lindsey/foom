import { expect, it } from "vitest";
import { command } from "../../../src/cli/commands";

const key = ["--idempotency-key", "retry-1"];
it.each([
  [
    ["create-worktree", "feature/test", ...key],
    "create_worktree",
    { branch: "feature/test", idempotencyKey: "retry-1" },
  ],
  [
    ["launch", "tree", "--agent", "agy", ...key],
    "launch",
    { worktreeId: "tree", agent: "agy", idempotencyKey: "retry-1" },
  ],
  [
    ["launch", "tree", "--agent", "codex", "--prompt", "x".repeat(16384), ...key],
    "launch",
    { worktreeId: "tree", agent: "codex", prompt: "x".repeat(16384), idempotencyKey: "retry-1" },
  ],
  [["stop", "child", ...key], "stop", { id: "child", idempotencyKey: "retry-1" }],
  [
    ["remove-worktree", "tree", ...key],
    "remove_worktree",
    { worktreeId: "tree", idempotencyKey: "retry-1" },
  ],
  [["tail", "child", "--lines", "40"], "tail", { id: "child", lines: 40 }],
  [["tail", "child"], "tail", { id: "child" }],
  [
    ["wait-for", "a", "b", "--after", '{"a":"rev"}', "--timeout-ms", "30000"],
    "wait_for",
    { ids: ["a", "b"], after: { a: "rev" }, timeoutMs: 30000 },
  ],
  [["wait-for", "a"], "wait_for", { ids: ["a"] }],
] as const)("maps command %j to the control API", (args, method, params) => {
  expect(command(args)).toEqual({ method, params });
});
it.each([
  ["create-worktree", "branch"],
  ["create-worktree", "  -option", ...key],
  ["create-worktree", "with space", ...key],
  ["create-worktree", "x".repeat(201), ...key],
  ["create-worktree", "bad\u202e", ...key],
  ["launch", "tree", "--agent", "shell", ...key],
  ["launch", "tree", "--agent", "claude", "--prompt", "", ...key],
  ["launch", "tree", "--agent", "claude", "--prompt", "-option", ...key],
  ["launch", "tree", "--agent", "claude", "--prompt", "bad\0", ...key],
  ["launch", "tree", "--agent", "claude", "--prompt", "é".repeat(8193), ...key],
  ["stop", "bad/id", ...key],
  ["remove-worktree", "tree", ...key, "--force", "true"],
  ["tail", "child", "--lines", "0"],
  ["tail", "child", "--lines", "41"],
  ["tail", "child", "--lines", "1.5"],
  ["tail", "child", "--lines"],
  ["tail", "child", "--lines", "1", "--lines", "2"],
  ["tail"],
  ["wait-for"],
  ["wait-for", "a", "a"],
  ["wait-for", "a", "b", "c", "d", "e"],
  ["wait-for", "a", "--after", "bad"],
  ["wait-for", "a", "--after", "null"],
  ["wait-for", "a", "--after", "[]"],
  ["wait-for", "a", "--after", '{"b":"rev"}'],
  ["wait-for", "a", "--after", '{"a":3}'],
  ["wait-for", "a", "--timeout-ms", "30001"],
  ["wait-for", "a", "--timeout-ms", "-1"],
  ["wait-for", "a", "--timeout-ms", "01"],
  ["whoami", "--token", "SECRET"],
  ["unknown"],
])("rejects malformed orchestration argv %j", (...args) => {
  expect(() => command(args)).toThrow("invalid_request");
});

it("parses reviewed replies and rejects control characters, slash commands and missing revision", () => {
  const args = ["reply", "child", "--revision", "rev", "--verdict-id", "verdict", ...key, "--text"];
  expect(command([...args, "answer"])).toEqual({
    method: "reply",
    params: {
      id: "child",
      revision: "rev",
      verdictId: "verdict",
      idempotencyKey: "retry-1",
      text: "answer",
    },
  });
  for (const text of ["line\nline", "/approve", "yes\r", "\u2028", "é".repeat(2049)])
    expect(() => command([...args, text])).toThrow("invalid_request");
  expect(() => command(["reply", "child", ...key, "--text", "answer"])).toThrow("invalid_request");
});

it("parses PR adoption without branch, remote or path parameters", () => {
  expect(command(["create-worktree", "--pull-request", "337", ...key])).toEqual({
    method: "create_worktree",
    params: { pullRequest: 337, idempotencyKey: "retry-1" },
  });
  for (const args of [
    ["create-worktree", "branch", "--pull-request", "337", ...key],
    ["create-worktree", "--pull-request", "0", ...key],
    ["create-worktree", "--pull-request", "9007199254740992", ...key],
    ["create-worktree", "--pull-request", "337", "--remote", "other", ...key],
  ])
    expect(() => command(args)).toThrow("invalid_request");
});
