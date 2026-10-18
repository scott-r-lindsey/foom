import { expect, test } from "vitest";
import { probeCommand, probeRequest } from "../../../src/node-common/agent-probe";
const id = "a".repeat(64);
test("probe CLI grammar and main validation agree", () => {
  const cases: [readonly string[], unknown][] = [
    [
      ["start", "copilot", "--manifest", "draft.json", "--resume", "abc-123"],
      { action: "start", agent: "copilot", manifest: "draft.json", resume: "abc-123" },
    ],
    [["start", "codex"], { action: "start", agent: "codex" }],
    [["send", id, "approve"], { action: "send", probe: id, text: "approve" }],
    [["wait", id, "--quiet", "0.5"], { action: "wait", probe: id, quiet: 0.5 }],
    [["wait", id, "--timeout", "600"], { action: "wait", probe: id, timeout: 600 }],
    ...["screen", "state", "stop"].map((action): [readonly string[], unknown] => [
      [action, id],
      { action, probe: id },
    ]),
    ...["esc", "ctrl-c", "enter", "up", "down", "tab"].map((key): [readonly string[], unknown] => [
      ["keys", id, key],
      { action: "keys", probe: id, key },
    ]),
  ];
  for (const [words, value] of cases) expect(probeCommand(words)).toEqual(value);
});
test("rejects extra flags, controls, foreign ID formats and malformed runtime values", () => {
  for (const words of [
    [],
    ["unknown", id],
    ["screen", id, "extra"],
    ["send", id],
    ["keys", id, "delete"],
    ["wait", id, "--quiet", "NaN"],
    ["wait", id, "--quiet", "1", "--timeout", "2"],
    ["wait", id, "--other", "1"],
    ["start", "shell"],
    ["start", "codex", "--bypass", "yes"],
    ["start", "codex", "--resume"],
    ["start", "codex", "--resume", "abc", "--resume", "abc"],
  ])
    expect(() => probeCommand(words)).toThrow("invalid_request");
  for (const value of [
    null,
    [],
    {},
    { action: "start", agent: "bad/id" },
    { action: "start", agent: "codex", manifest: 0 },
    { action: "start", agent: "codex", manifest: "\0" },
    { action: "start", agent: "codex", manifest: "" },
    { action: "start", agent: "codex", resume: "" },
    { action: "start", agent: "codex", extra: true },
    { action: "screen", probe: "terminal" },
    { action: "send", probe: id, text: "hello\rworld" },
    { action: "send", probe: id, text: "\x1b[2J" },
    { action: "send", probe: id, text: "x".repeat(16385) },
    { action: "send", probe: id, text: 0 },
    { action: "keys", probe: id, key: "constructor" },
    { action: "wait", probe: id },
    { action: "wait", probe: id, quiet: 1, timeout: 2 },
    { action: "wait", probe: id, quiet: 0 },
    { action: "wait", probe: id, quiet: 601 },
    { action: "wait", probe: id, quiet: Infinity },
    { action: "wait", probe: id, timeout: "1" },
  ])
    expect(() => probeRequest(value)).toThrow("invalid_request");
});
