import { expect, it } from "vitest";
import { cliGuidance } from "../../../../src/main/agents/cli-launch";
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

it("gives Antigravity orchestrators CLI mutations instead of read-only guidance", () => {
  const args = cliGuidance(["-i", "User data"], true);
  expect(args[1]).toContain("User data");
  expect(args[1]).toContain("create-worktree/create_worktree");
  expect(args[1]).not.toContain("mutations are unavailable");
});
