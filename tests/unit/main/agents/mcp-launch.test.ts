import { readFile, stat } from "node:fs/promises";
import type * as Fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { prepareMcpLaunch, supportsMcp } from "../../../../src/main/agents/mcp-launch";
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof Fs>()) }));
it("uses unique additive server names, env credentials and cleans up private Claude files", async () => {
  const endpoint = "http://127.0.0.1:1234/control/v1";
  const claude = await prepareMcpLaunch("claude", endpoint);
  const other = await prepareMcpLaunch("claude", endpoint);
  const codex = await prepareMcpLaunch("codex", endpoint);
  try {
    const path = claude.args[1] ?? "";
    const content = await readFile(path, "utf8");
    expect(content).toContain("Bearer ${FOOM_CONTROL_TOKEN}");
    expect(content).toContain("http://127.0.0.1:1234/mcp");
    expect(content).not.toBe(await readFile(other.args[1] ?? "", "utf8"));
    expect(claude.args).not.toContain("--strict-mcp-config");
    const config: unknown = JSON.parse(content);
    if (
      typeof config !== "object" ||
      config === null ||
      !("mcpServers" in config) ||
      typeof config.mcpServers !== "object" ||
      config.mcpServers === null
    )
      throw new Error("Expected MCP servers");
    const [name] = Object.keys(config.mcpServers);
    if (name === undefined) throw new Error("Expected per-launch server name");
    expect(name).toMatch(/^foom_[a-f0-9]+$/u);
    expect(claude.args.slice(2)).toEqual([
      "--allowedTools",
      `mcp__${name}__open_preview,mcp__${name}__list_previews,mcp__${name}__close_preview`,
    ]);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(codex.args).toEqual(["-c", expect.stringMatching(/^mcp_servers\.foom_[a-f0-9]+=/u)]);
    expect(codex.args[1]).toContain('bearer_token_env_var="FOOM_CONTROL_TOKEN"');
  } finally {
    claude.dispose();
    other.dispose();
    codex.dispose();
  }
  await expect
    .poll(() =>
      stat(claude.args[1] ?? "").then(
        () => false,
        () => true,
      ),
    )
    .toBe(true);
});
it("refuses unsupported agents and non-loopback endpoints", async () => {
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
    await expect(prepareMcpLaunch("claude", endpoint)).rejects.toThrow();
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

it("cleans incomplete attachments and tolerates cleanup failures without exposing credentials", async () => {
  const files = await import("node:fs/promises");
  const privateFiles = await import("../../../../src/main/control/private-files");
  const created = vi.spyOn(files, "mkdtemp");
  const writing = vi
    .spyOn(privateFiles, "atomicPrivate")
    .mockRejectedValueOnce(new Error("denied"));
  try {
    await expect(prepareMcpLaunch("claude", "http://127.0.0.1:1234/control/v1")).rejects.toThrow(
      "denied",
    );
    const directory: unknown = await created.mock.results[0]?.value;
    if (typeof directory !== "string") throw new Error("Expected launch directory");
    await expect(stat(directory)).rejects.toThrow();
  } finally {
    writing.mockRestore();
    created.mockRestore();
  }
  const launch = await prepareMcpLaunch("claude", "http://127.0.0.1:1234/control/v1");
  const remove = vi.spyOn(files, "rm").mockRejectedValueOnce(new Error("busy"));
  launch.dispose();
  await Promise.resolve();
  remove.mockRestore();
  launch.dispose();
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
