import { expect, it } from "vitest";
import { cliGuidance } from "../../../../src/main/agents/cli-launch";
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
