import { expect, test } from "vitest";
import {
  agentName,
  examplePath,
  inferenceSummary,
  pollRows,
  readyAgents,
  signal,
} from "../src/renderer/preflight";
import { installation, report, setupState } from "./fixtures/setup";

const repo = { path: "/code/app", name: "app" };

test("ready agents are installed and switched on", () => {
  const scan = report(installation("claude"), installation("codex", false), installation("agy"));
  expect(readyAgents(scan, setupState()).map((agent) => agent.id)).toEqual(["claude", "agy"]);
  const off = setupState({ agents: { claude: false, codex: true, agy: true } });
  expect(readyAgents(scan, off).map((agent) => agent.id)).toEqual(["agy"]);
  expect(readyAgents(undefined, setupState())).toEqual([]);
  expect(agentName("codex")).toBe("Codex");
});

test("each agent's signal follows its hook support and the hooks setting", () => {
  expect(signal(installation("claude"), true)).toBe("hooks");
  expect(signal(installation("codex"), true)).toBe("notify");
  expect(signal(installation("agy"), true)).toBe("evaluator");
  expect(signal(installation("claude"), false)).toBe("evaluator");
});

test("summaries and example paths describe the saved choices", () => {
  expect(inferenceSummary({ kind: "rules" })).toMatch(/^Rules only/);
  expect(inferenceSummary({ kind: "openai", model: "gpt-4.1-mini" })).toBe(
    "OpenAI API · gpt-4.1-mini",
  );
  expect(
    inferenceSummary({ kind: "local", model: "qwen3:8b", endpoint: "http://127.0.0.1:1/v1" }),
  ).toBe("Local · qwen3:8b at http://127.0.0.1:1/v1");
  expect(examplePath(setupState(), [repo])).toBe("/home/me/.foom/worktrees/app/feat/search");
  expect(examplePath(setupState(), [])).toBe("/home/me/.foom/worktrees/app/feat/search");
  const adjacent = setupState({ worktreeLocation: "adjacent" });
  expect(examplePath(adjacent, [repo])).toBe("/code/app-feat/search");
  expect(examplePath(adjacent, [])).toBe("~/code/app-feat/search");
});

test("go / no-go needs a ready agent, a repository and a usable evaluator", () => {
  const scan = report(installation("claude"), installation("codex"), installation("agy"));
  const all = pollRows(setupState(), scan, [repo]);
  expect(all.every((row) => row.go)).toBe(true);
  expect(all.map((row) => row.detail)).toEqual([
    "Claude Code, Codex, Antigravity",
    "Claude Code: hooks · Codex: notify · Antigravity: evaluator",
    "app",
    "/home/me/.foom/worktrees",
    "Rules only. Ambiguous terminals stay neutral",
  ]);

  const none = pollRows(setupState({ worktreeLocation: "adjacent" }), report(), []);
  expect(none.filter((row) => !row.go).map((row) => [row.system, row.step])).toEqual([
    ["Agents", 1],
    ["Repositories", 2],
  ]);
  expect(none[0]?.detail).toMatch(/Install Claude Code, Codex or Antigravity/);
  expect(none[1]?.detail).toBe("Nothing to watch yet");
  expect(none[3]?.detail).toBe("Next to each repository");
  expect(pollRows(setupState(), undefined, [])[0]?.detail).toBe("Still scanning");

  const cloud = { kind: "anthropic", model: "claude-haiku-4-5" } as const;
  const missing = pollRows(setupState({ inference: cloud }), scan, [repo])[4];
  expect(missing).toMatchObject({ go: false, step: 3 });
  const keyed = setupState(
    { inference: cloud },
    { keys: { anthropic: true, openai: false, google: false } },
  );
  expect(pollRows(keyed, scan, [repo])[4]).toMatchObject({ go: true });
  const local = { kind: "local", model: "m", endpoint: "http://127.0.0.1:1/v1" } as const;
  expect(pollRows(setupState({ inference: local }), scan, [repo])[4]?.go).toBe(true);
});
