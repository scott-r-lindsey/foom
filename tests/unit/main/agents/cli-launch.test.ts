import { collectMerge } from "../../../../src/main/agents/providers/v2-values";
import manifest from "../../../../src/shared/bundled-agents/claude.json";
function mergeAllowedTools(args: readonly string[]): string[] {
  const merge = manifest.launch.toolPermissions.merge;
  const collected = collectMerge(args, { ...merge, separators: "whitespace-comma-parentheses" });
  return [...collected.args, merge.output, ...new Set(collected.values)];
}
import { expect, it } from "vitest";
import { CLI_GUIDANCE, cliGuidance } from "../../../../src/main/agents/cli-launch";
import * as cliLaunch from "../../../../src/main/agents/cli-launch";
it("composes Antigravity initial prompt data without invoking a shell or changing MCP", () => {
  expect(cliGuidance([])).toEqual([
    "--prompt-interactive",
    expect.stringContaining("foom whoami --json"),
  ]);
  expect(
    cliGuidance([
      "--model",
      "example",
      "-i",
      "literal $(command)",
      "--prompt-interactive=other",
      "-i=third",
    ]),
  ).toEqual([
    "--model",
    "example",
    "--prompt-interactive",
    expect.stringMatching(/^literal \$\(command\)\n\nother\n\nthird/u),
  ]);
  expect(cliGuidance(["--prompt-interactive", "user text"])[1]).toContain("user text\n\nFoom");
  expect(() => cliGuidance(["-i"])).toThrow("missing its value");
});

it("passes an orchestrator child's prompt as one argv entry and refuses option-like prompts", () => {
  const { initialPrompt, CHILD_PROMPT } = cliLaunch;
  expect(initialPrompt({ id: "claude" }, undefined)).toEqual({ guidance: [], positional: [] });
  expect(initialPrompt({ id: "codex" }, "Fix it\n\tthen test")).toEqual({
    guidance: [],
    positional: ["--", `${CHILD_PROMPT}\n\nFix it\n\tthen test`],
  });
  // A bare subcommand name never reaches the CLI as its own argv entry.
  expect(initialPrompt({ id: "codex" }, "logout").positional).toEqual([
    "--",
    `${CHILD_PROMPT}\n\nlogout`,
  ]);
  expect(initialPrompt({ id: "agy", cliGuidance: true }, "Plan")).toEqual({
    guidance: ["--prompt-interactive", `${CHILD_PROMPT}\n\nPlan`],
    positional: [],
  });
  expect(() => initialPrompt({ id: "agy" }, "Plan")).toThrow("cannot take a prompt");
  for (const prompt of ["", "  --yolo", "bell\u0007", "x".repeat(16385)])
    expect(() => initialPrompt({ id: "claude" }, prompt)).toThrow("Invalid initial prompt");
});

it("gives Antigravity one CLI guidance for either role, after the user's own prompt", () => {
  const args = cliGuidance(["-i", "User data"]);
  expect(args).toEqual(["--prompt-interactive", `User data\n\n${CLI_GUIDANCE}`]);
  expect(CLI_GUIDANCE).toContain("foom whoami --json lists your current capabilities");
  expect(CLI_GUIDANCE).not.toContain("mutations are unavailable");
});

it("merges Claude allow aliases, equals forms and variadic rules without widening patterns", () => {
  const grants =
    "mcp__foom_launch__open_preview,mcp__foom_launch__list_previews,mcp__foom_launch__close_preview";
  expect(mergeAllowedTools(["--mcp-config", "private.json", "--allowedTools", grants])).toEqual([
    "--mcp-config",
    "private.json",
    "--allowedTools",
    ...grants.split(","),
  ]);
  expect(
    mergeAllowedTools([
      "--model",
      "example",
      "--allowedTools",
      "Read,Edit",
      "Bash(git log *, git diff *)",
      "Read",
      "--allowed-tools=Read mcp__foom_launch__open_preview",
      "--allowedTools=Edit",
      "--allowed-tools",
      "Write",
      "--permission-mode",
      "default",
      "--allowedTools",
      grants,
    ]),
  ).toEqual([
    "--model",
    "example",
    "--permission-mode",
    "default",
    "--allowedTools",
    "Read",
    "Edit",
    "Bash(git log *, git diff *)",
    "mcp__foom_launch__open_preview",
    "Write",
    "mcp__foom_launch__list_previews",
    "mcp__foom_launch__close_preview",
  ]);
});
