import {
  agentProvider,
  replaceConfigProviders,
} from "../../../../src/main/agents/providers/registry";
import fixture from "../../../fixtures/agent-plugin.json";
import { parseAgentPlugin } from "../../../../src/shared/agent-manifest";
import { configProvider } from "../../../../src/main/agents/providers/config";
import { expect, it } from "vitest";
import { prepareMcpLaunch, supportsMcp } from "../../../../src/main/agents/mcp-launch";
it("requires the shared launch context for bundled MCP", async () => {
  await expect(prepareMcpLaunch("codex", "http://127.0.0.1:1234/control/v1")).rejects.toThrow(
    "launch context",
  );
});

it("refuses unsupported agents and non-loopback endpoints", async () => {
  await expect(agentProvider("agy").prepareMcp("http://127.0.0.1:1234/control/v1")).rejects.toThrow(
    "unsupported",
  );
  await expect(prepareMcpLaunch("agy", "http://127.0.0.1:1234/control/v1")).rejects.toThrow(
    "unsupported",
  );
  for (const endpoint of [
    "https://example.org/control/v1",
    "http://localhost:1/control/v1",
    "http://127.0.0.1/control/v1",
    "http://127.0.0.1:1/control/v1?x=1",
    "http://u:p@127.0.0.1:1/control/v1",
    "http://127.0.0.1:1/other",
  ])
    await expect(prepareMcpLaunch("codex", endpoint)).rejects.toThrow();
});
it("requires a stable release at or above the tested floor and the exact attachment flag", () => {
  expect(supportsMcp("claude", "2.1.293 (Claude Code)", " --mcp-config <file>")).toBe(true);
  expect(supportsMcp("codex", "codex-cli 0.161.0", " -c, --config <value>")).toBe(true);
  for (const agent of ["claude", "codex", "agy"] as const) {
    expect(supportsMcp(agent, "unknown", "--mcp-config -c")).toBe(false);
    expect(
      supportsMcp(
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
  expect(supportsMcp("claude", version, "--mcp-config=<file>")).toBe(expected);
  expect(supportsMcp("claude", `${version} (Claude Code)`, "--mcp-config <file>")).toBe(expected);
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
  expect(supportsMcp("codex", `codex-cli ${version}`, "  -c, --config <value>")).toBe(expected);
});
it.each(["", "--mcp-config-extra -config", "x--mcp-config x-c", "--config"])(
  "rejects missing or lookalike flags %s",
  (help) => {
    expect(supportsMcp("claude", "2.1.296", help)).toBe(false);
    expect(supportsMcp("codex", "codex-cli 0.162.1", help)).toBe(false);
  },
);

it("does not grant v1 plugins the v2 MCP discovery or attachment capability", async () => {
  const manifest = parseAgentPlugin(JSON.stringify(fixture));
  replaceConfigProviders([configProvider(manifest, () => Promise.resolve())]);
  try {
    expect(supportsMcp(manifest.id, "1.0.0", "--mcp -c --mcp-config")).toBe(false);
    await expect(prepareMcpLaunch(manifest.id, "http://127.0.0.1:1234/control/v1")).rejects.toThrow(
      "unsupported",
    );
  } finally {
    replaceConfigProviders([]);
  }
});
