import { expect, it } from "vitest";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import type { AgentLaunch } from "../../../../src/shared/agents";
const request: AgentLaunch = {
  agent: "codex",
  repository: "/fixture",
  worktree: "/fixture",
  cols: 80,
  rows: 24,
};
function discoveredMcp(agent: string, version: string, help: string): boolean {
  return agentProvider(agent).discover("/fixture/agent", version, help).mcp === true;
}
it("prepares bundled MCP only with a supported discovery result and a control attachment", async () => {
  const provider = agentProvider("codex");
  const install = provider.discover("/fixture/codex", "codex-cli 0.161.0", "-c");
  for (const control of [
    undefined,
    {
      env: {
        FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1",
        FOOM_CONTROL_TOKEN: "private-token",
      },
      bind: () => undefined,
      dispose: () => undefined,
    },
  ]) {
    const prepared = await provider.prepareLaunch(install, request, [], control, false, false);
    try {
      expect(prepared.mcp).toBe(Boolean(control));
      expect(prepared.mcpArguments).toEqual(
        control
          ? [
              "-c",
              expect.stringMatching(
                /^mcp_servers\.foom_[a-f0-9]+=\{url="http:\/\/127\.0\.0\.1:1234\/mcp",bearer_token_env_var="FOOM_CONTROL_TOKEN"\}$/u,
              ),
            ]
          : [],
      );
      expect(prepared.args.join(" ")).not.toContain("private-token");
    } finally {
      prepared.dispose();
    }
  }
});
it("does not attach MCP for unsupported agents even with control credentials", async () => {
  const provider = agentProvider("agy");
  const prepared = await provider.prepareLaunch(
    provider.discover("", "1.3.3", ""),
    { ...request, agent: "agy" },
    [],
    { env: { FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1" }, dispose: () => undefined },
    false,
    false,
  );
  try {
    expect(prepared.mcp).toBe(false);
    expect(prepared.mcpArguments).toEqual([]);
  } finally {
    prepared.dispose();
  }
});
it.each([
  "https://example.org/control/v1",
  "http://localhost:1/control/v1",
  "http://127.0.0.1/control/v1",
  "http://127.0.0.1:1/control/v1?x=1",
  "http://127.0.0.1:1/control/v1#fragment",
  "http://u:p@127.0.0.1:1/control/v1",
  "http://127.0.0.1:1/other",
])("refuses invalid MCP endpoint %s in prepareLaunch", async (endpoint) => {
  const provider = agentProvider("codex");
  const install = provider.discover("/fixture/codex", "codex-cli 0.161.0", "-c");
  await expect(
    provider.prepareLaunch(
      install,
      request,
      [],
      { env: { FOOM_CONTROL_URL: endpoint }, dispose: () => undefined },
      false,
      false,
    ),
  ).rejects.toThrow("Invalid control endpoint");
});
it("requires a stable release at or above the tested floor and the exact attachment flag", () => {
  expect(discoveredMcp("claude", "2.1.293 (Claude Code)", " --mcp-config <file>")).toBe(true);
  expect(discoveredMcp("codex", "codex-cli 0.161.0", " -c, --config <value>")).toBe(true);
  for (const agent of ["claude", "codex", "agy"] as const) {
    expect(discoveredMcp(agent, "unknown", "--mcp-config -c")).toBe(false);
    expect(
      discoveredMcp(
        agent,
        agent === "claude" ? "2.1.293 (Claude Code)" : "codex-cli 0.161.0",
        "--mcp-config-extra -config",
      ),
    ).toBe(false);
  }
});

it.each([
  ["2.1.292", false],
  ["2.1.293", true],
  ["2.1.296", true],
  ["2.2.0", true],
  ["3.0.0", true],
  ["1.99.999", false],
  ["2.1", false],
  ["02.1.293", false],
  ["2.1.293-beta.1", false],
  ["2.1.293+build", false],
  ["2.1.9007199254740992", false],
  ["junk 2.1.293", false],
])("Claude floor parses %s as %s", (version, expected) => {
  expect(discoveredMcp("claude", version, "--mcp-config=<file>")).toBe(expected);
  expect(discoveredMcp("claude", `${version} (Claude Code)`, "--mcp-config <file>")).toBe(expected);
});
it.each([
  ["0.160.9", false],
  ["0.161.0", true],
  ["0.162.1", true],
  ["1.0.0", true],
  ["0.161", false],
  ["0.0161.0", false],
  ["0.162.1-alpha.1", false],
  ["0.162.1+build", false],
  ["0.161.9007199254740992", false],
  ["unknown", false],
])("Codex floor parses %s as %s", (version, expected) => {
  expect(discoveredMcp("codex", `codex-cli ${version}`, "  -c, --config <value>")).toBe(expected);
});
it.each(["", "--mcp-config-extra -config", "x--mcp-config x-c", "--config"])(
  "rejects missing or lookalike flags %s",
  (help) => {
    expect(discoveredMcp("claude", "2.1.296", help)).toBe(false);
    expect(discoveredMcp("codex", "codex-cli 0.162.1", help)).toBe(false);
  },
);
