import { expect, test } from "vitest";
import type { AgentId } from "../../../../src/shared/agents";
import {
  EMPTY_AGENT_ARGUMENTS,
  hasBypassArgument,
  parseAgentArguments,
  parseAgentDefaults,
} from "../../../../src/main/agents/default-arguments";

test("copies bounded argument arrays verbatim, including whitespace and shell syntax", () => {
  const args = ["--model", "a model", "'quotes'", '"double"', "$(touch /tmp/no)", " ; & "];
  expect(parseAgentArguments("claude", args)).toEqual(args);
  expect(parseAgentArguments("codex", [])).toEqual([]);
  expect(
    parseAgentArguments(
      "agy",
      Array.from({ length: 64 }, () => "a".repeat(4096)),
    ),
  ).toHaveLength(64);
  const parsed = parseAgentDefaults({ ...EMPTY_AGENT_ARGUMENTS, claude: args });
  args.push("later");
  expect(parsed.claude).not.toContain("later");
  expect(Object.isFrozen(parsed.claude)).toBe(true);
});

test.each([
  null,
  {},
  "--model x",
  Array(65).fill("x"),
  [""],
  [1],
  ["x".repeat(4097)],
  ["\0"],
  ["a\nb"],
  ["a\tb"],
  ["\x7f"],
  ["\u0085"],
  Array(1),
])("rejects malformed argv %j", (value) => {
  expect(() => parseAgentArguments("claude", value)).toThrow();
});

test.each([
  null,
  [],
  {},
  { claude: [], codex: [] },
  { claude: [], codex: [], other: [] },
  { claude: [], agy: [], other: [] },
  { codex: [], agy: [], other: [] },
  { ...EMPTY_AGENT_ARGUMENTS, other: [] },
  { ...EMPTY_AGENT_ARGUMENTS, agy: [null] },
])("requires exactly the three supported agents %j", (value) => {
  expect(() => parseAgentDefaults(value)).toThrow();
});

test.each<[AgentId, string[]]>([
  ["claude", ["--settings", "{}"]],
  ["claude", ["--settings={}"]],
  ["claude", ["--safe-mode"]],
  ["claude", ["--bare"]],
  ["claude", ["--bare=true"]],
  ["claude", ["--no-alt-screen"]],
  ["codex", ["--no-alt-screen=true"]],
  ["agy", ["--"]],
])("reserves Foom's flags for %s: %j", (agent, args) => {
  expect(() => parseAgentArguments(agent, args)).toThrow(/reserved|prevent/u);
});

test.each([
  ["-c", "notify=[]"],
  ["--config", "hooks={}"],
  ["--config=notify=[]"],
  ["--config=hooks.foo=false"],
  ["-cnotify=[]"],
  ["-c=hooks=[]"],
  ["-c", " hooks . enabled =false"],
  ["--config", '"notify"=[]'],
  ["-c", "profiles.test.hooks={}"],
])("rejects notifier and hook overrides %j", (...args) => {
  expect(() => parseAgentArguments("codex", args)).toThrow("attention detection");
});

test.each([
  ["-c", "model_reasoning_effort=high"],
  ["--config=model=x"],
  ["-cmodel=x"],
  ["--model", "x"],
  ["-c"],
  ["--config"],
  ["-c", "notifying=true"],
])("allows unrelated Codex flags %j", (...args) => {
  expect(parseAgentArguments("codex", args)).toEqual(args);
});

test.each<[AgentId, string[], boolean]>([
  ["claude", ["--dangerously-skip-permissions"], true],
  ["codex", ["--dangerously-bypass-approvals-and-sandbox"], true],
  ["agy", ["--dangerously-skip-permissions"], true],
  ["claude", ["--permission-mode", "bypassPermissions"], true],
  ["claude", ["--permission-mode=bypassPermissions"], true],
  ["claude", ["--permission-mode", "plan"], false],
  ["claude", ["--permission-mode"], false],
  ["claude", ["--allow-dangerously-skip-permissions"], false],
  ["codex", ["--approve-for-me"], false],
  ["codex", ["--dangerously-skip-permissions"], false],
  ["agy", ["--mode", "accept-edits"], false],
  ["agy", [], false],
])("detects known bypass flags for %s %j", (agent, args, expected) => {
  expect(hasBypassArgument(agent, args)).toBe(expected);
});
