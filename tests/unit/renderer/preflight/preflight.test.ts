import { expect, test } from "vitest";
import {
  signalNote,
  versionNumber,
  agentName,
  examplePath,
  pollRows,
  readyAgents,
  signal,
} from "../../../../src/renderer/preflight/preflight";
import { installation, report, setupState } from "../../../fixtures/setup";

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
  expect(signal(installation("agy"), true)).toBe("rules");
  expect(signal(installation("claude"), false)).toBe("rules");
});

test("summaries and example paths describe the saved choices", () => {
  expect(examplePath(setupState(), [repo])).toBe("/home/me/.foom/worktrees/app/feat/search");
  expect(examplePath(setupState(), [])).toBe("/home/me/.foom/worktrees/app/feat/search");
  const adjacent = setupState({ worktreeLocation: "adjacent" });
  expect(examplePath(adjacent, [repo])).toBe("/code/app-feat/search");
  expect(examplePath(adjacent, [])).toBe("~/code/app-feat/search");
});

test("go / no-go needs a ready agent and a repository", () => {
  const scan = report(installation("claude"), installation("codex"), installation("agy"));
  const all = pollRows(setupState(), scan, [repo]);
  expect(all.every((row) => row.go)).toBe(true);
  expect(all.map((row) => row.detail)).toEqual([
    "Claude Code, Codex, Antigravity",
    "Claude Code: hooks · Codex: notify · Antigravity: rules",
    "app",
    "/home/me/.foom/worktrees",
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
});

test("the signal tooltip explains only what is unusual", () => {
  const hooksTooOld = { ...installation("claude"), hooks: false, reason: "Too old for hooks." };
  expect(signalNote(hooksTooOld, true)).toBe("Too old for hooks.");
  expect(signalNote(hooksTooOld, false)).toBeUndefined();
  expect(signalNote(installation("claude"), true)).toBeUndefined();
  expect(signalNote(installation("codex"), true)).toMatch(/Replaces your own Codex notifier/);
  expect(signalNote(installation("agy"), true)).toBeUndefined();
});

test("the version badge shows just the number, however the agent words it", () => {
  expect(versionNumber("2.1.285 (Claude Code)")).toBe("2.1.285");
  expect(versionNumber("codex-cli 0.155.1")).toBe("0.155.1");
  expect(versionNumber("1.2.13")).toBe("1.2.13");
  expect(versionNumber("agy 2.0.0-beta.3 (abc123)")).toBe("2.0.0-beta.3");
  expect(versionNumber("tool v12.4")).toBe("12.4");
  expect(versionNumber("development build")).toBeNull();
  expect(versionNumber(null)).toBeNull();
});
