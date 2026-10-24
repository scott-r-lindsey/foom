import { afterEach, expect, it } from "vitest";
import { CHILD_PROMPT, CLI_GUIDANCE } from "../../../../src/main/agents/providers/cli-launch";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import type { AgentId } from "../../../../src/shared/agents";

const cleanup: (() => void)[] = [];
const previewTools = ["open_preview", "list_previews", "close_preview"];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

async function prepare(
  agent: AgentId,
  defaults: readonly string[] = [],
  prompt?: string,
  control = false,
) {
  const provider = agentProvider(agent);
  // Empty executable paths skip Antigravity setup probes. This tests argv preparation only.
  const installation = provider.discover(
    "",
    agent === "claude"
      ? "2.1.293 (Claude Code)"
      : agent === "codex"
        ? "codex-cli 0.161.0"
        : "1.3.3",
    "--settings -c --mcp-config --prompt-interactive",
  );
  const prepared = await provider.prepareLaunch(
    installation,
    {
      agent,
      repository: "/fixture",
      worktree: "/fixture",
      cols: 80,
      rows: 24,
      ...(prompt === undefined ? {} : { prompt }),
    },
    defaults,
    control
      ? {
          env: {
            FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1",
            FOOM_CONTROL_TOKEN: "private-token",
          },
          toolNames: previewTools,
          dispose: () => undefined,
        }
      : undefined,
    false,
    false,
  );
  cleanup.push(() => {
    prepared.dispose();
  });
  return prepared;
}

it("composes Antigravity initial prompt data without invoking a shell or changing MCP", async () => {
  const empty = await prepare("agy", [], undefined, true);
  expect(empty.mcp).toBe(false);
  expect(empty.args).toEqual(["--prompt-interactive", CLI_GUIDANCE]);
  const combined = await prepare(
    "agy",
    ["--model", "example", "-i", "literal $(command)", "--prompt-interactive=other", "-i=third"],
    undefined,
    true,
  );
  expect(combined.args).toEqual([
    "--model",
    "example",
    "--prompt-interactive",
    `literal $(command)\n\nother\n\nthird\n\n${CLI_GUIDANCE}`,
  ]);
  expect(
    (await prepare("agy", ["--prompt-interactive", "user text"], undefined, true)).args,
  ).toEqual(["--prompt-interactive", `user text\n\n${CLI_GUIDANCE}`]);
  await expect(prepare("agy", ["-i"], undefined, true)).rejects.toThrow("missing its value");
});

it.each(["claude", "codex"] as const)(
  "passes a %s child's prompt as one argv entry and refuses unsafe prompts through prepareLaunch",
  async (agent) => {
    for (const prompt of [
      undefined,
      "Fix it\n\tthen test",
      "logout",
      "Keep $(command) and {mcpName} literal",
    ]) {
      const prepared = await prepare(agent, [], prompt);
      if (prompt === undefined) expect(prepared.args).not.toContain("--");
      else expect(prepared.args.slice(-2)).toEqual(["--", `${CHILD_PROMPT}\n\n${prompt}`]);
    }
    for (const prompt of [
      "",
      "  --yolo",
      "bell\u0007",
      "bad\u0000",
      "bad\r",
      "x".repeat(16385),
      "é".repeat(8193),
    ])
      await expect(prepare(agent, [], prompt)).rejects.toThrow("Invalid initial prompt");
  },
);

it("gives Antigravity one CLI guidance for either role, after the user's own prompt", async () => {
  const prepared = await prepare("agy", ["-i", "User data"], undefined, true);
  expect(prepared.args).toEqual(["--prompt-interactive", `User data\n\n${CLI_GUIDANCE}`]);
  expect(CLI_GUIDANCE).toContain("foom whoami --json lists your current capabilities");
  expect(CLI_GUIDANCE).not.toContain("mutations are unavailable");
});

const userGrants = previewTools.map((tool) => `mcp__foom_launch__${tool}`);
it.each([
  { defaults: ["--allowedTools", userGrants.join(",")], prefix: [], rules: userGrants },
  {
    defaults: [
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
      userGrants.join(","),
    ],
    prefix: ["--model", "example", "--permission-mode", "default"],
    rules: [
      "Read",
      "Edit",
      "Bash(git log *, git diff *)",
      "mcp__foom_launch__open_preview",
      "Write",
      "mcp__foom_launch__list_previews",
      "mcp__foom_launch__close_preview",
    ],
  },
])(
  "merges Claude allow aliases, equals forms and variadic rules without widening patterns: $defaults",
  async ({ defaults, prefix, rules }) => {
    const prepared = await prepare("claude", defaults, undefined, true);
    const server = prepared.args
      .find((arg) => /^mcp__foom_[a-f0-9]+__open_preview$/u.test(arg))
      ?.split("__")[1];
    if (!server) throw Error("Missing generated MCP grants");
    const grants = previewTools.map((tool) => `mcp__${server}__${tool}`);
    expect(prepared.mcp).toBe(true);
    expect(prepared.args).toEqual([
      ...prefix,
      "--mcp-config",
      expect.any(String),
      "--allowedTools",
      ...rules,
      ...grants,
    ]);
    for (const grant of grants)
      expect(prepared.args.filter((arg) => arg === grant)).toHaveLength(1);
    expect(prepared.args.join(" ")).not.toContain("private-token");
  },
);
