import {
  create,
  launchIdentity,
  listWorktrees,
  prepare,
  request,
  root,
  agentFixture,
  versions,
} from "./agents-fixture";
import { ChildProcess, execFile } from "node:child_process";
import { statSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentService, loginPath } from "../../../../src/main/agents/agents";
import { replaceConfigProviders } from "../../../../src/main/agents/providers/registry";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import pluginFixture from "../../../fixtures/agent-plugin.json";

describe("detection", () => {
  it("preserves full versions and probes help before advertising hooks", async () => {
    const scan = await agentFixture.service.scan();
    expect(scan.path).toBe(root);
    expect(scan.agents.map((agent) => [agent.id, agent.version, agent.hooks])).toEqual([
      ["claude", versions.claude, true],
      ["codex", versions.codex, true],
      ["agy", versions.agy, false],
      ["pi", versions["pi"], false],
    ]);
    expect(Object.isFrozen(scan.agents[0])).toBe(true);
    expect(execFile).toHaveBeenCalledWith(
      expect.stringContaining("codex"),
      ["--help"],
      expect.objectContaining({ timeout: 5000, maxBuffer: 262144 }),
      expect.any(Function),
    );
  });
  it.each([
    ["2.1.284 (Claude Code)", "codex-cli 0.155.1", true],
    ["2.1.285 (Claude Code)", "codex-cli 0.155.2", true],
    ["2.2.0 (Claude Code)", "codex-cli 0.156.0", true],
    ["3.0.0 (Claude Code)", "codex-cli 1.0.0", true],
    ["2.1.284", "codex-cli 99.0.0", true],
    ["2.1.283 (Claude Code)", "codex-cli 0.155.0", false],
    ["2.0.999 (Claude Code)", "codex-cli 0.154.999", false],
    ["1.99.999 (Claude Code)", "codex-cli 0.1.999", false],
    ["2.1.284-beta.1 (Claude Code)", "codex-cli 0.155.1-rc.1", false],
    ["3.0.0+custom (Claude Code)", "codex-cli 1.0.0+custom", false],
    ["garbage", "codex-cli unknown", false],
    ["02.1.284 (Claude Code)", "codex-cli 00.155.1", false],
    ["999999999999999999.0.0", "codex-cli 999999999999999999.0.0", false],
  ])("gates stable releases %s / %s", async (claude, codex, hooks) => {
    const previous = { ...versions };
    try {
      versions.claude = claude;
      versions.codex = codex;
      const scan = await agentFixture.service.scan();
      expect(scan.agents.slice(0, 2).map((agent) => agent.hooks)).toEqual([hooks, hooks]);
      expect(scan.agents[0]?.version).toBe(claude);
      await expect(agentFixture.service.launch(request)).resolves.toHaveProperty(
        "attention",
        hooks ? "hooks" : "evaluator",
      );
    } finally {
      Object.assign(versions, previous);
    }
  });
  it.each(["--other", "--settings-file -config", "prefix--settings prefix-c"])(
    "requires complete help flags (%s)",
    async (text) => {
      agentFixture.help = text;
      expect((await agentFixture.service.scan()).agents.every((agent) => !agent.hooks)).toBe(true);
    },
  );
  it("reports missing executables and rescans without retaining stale results", async () => {
    vi.mocked(access).mockRejectedValue(new Error("missing"));
    expect((await agentFixture.service.scan()).agents.every((agent) => agent.path === null)).toBe(
      true,
    );
    await expect(agentFixture.service.launch(request)).rejects.toThrow("not installed");
    vi.mocked(access).mockResolvedValue();
    expect((await agentFixture.service.scan()).agents.every((agent) => agent.path !== null)).toBe(
      true,
    );
    await expect(agentFixture.service.launch(request)).resolves.toMatchObject({
      id: "terminal-id",
      attention: "hooks",
    });
  });
  it("does not treat directories as executables", async () => {
    vi.mocked(stat).mockResolvedValue(
      Object.assign(statSync(process.execPath, { bigint: true }), { isFile: () => false }),
    );
    expect((await agentFixture.service.scan()).agents.every((agent) => agent.path === null)).toBe(
      true,
    );
  });
  it("falls back for failed probes, empty versions, and unsupported help", async () => {
    agentFixture.failed = "--help";
    expect(
      (await agentFixture.service.scan()).agents.every((agent) => !agent.hooks && agent.version),
    ).toBe(true);
    agentFixture.failed = "--version";
    expect(
      (await agentFixture.service.scan()).agents.every(
        (agent) => !agent.hooks && agent.version === null,
      ),
    ).toBe(true);
    agentFixture.failed = "";
    const previous = versions.claude;
    versions.claude = "";
    agentFixture.help = "--other";
    expect((await agentFixture.service.scan()).agents.every((agent) => !agent.hooks)).toBe(true);
    versions.claude = previous;
  });
  it("keeps unknown versions on evaluator fallback", async () => {
    const previous = versions.codex;
    versions.codex = "codex-cli unknown";
    expect((await agentFixture.service.scan()).agents[1]?.hooks).toBe(false);
    versions.codex = previous;
    await agentFixture.service.launch({ ...request, agent: "codex" });
    expect(prepare).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === "win32")(
    "recovers from login-shell failure and ignores relative PATH entries",
    async () => {
      agentFixture.failed = "-ilc";
      vi.stubEnv("PATH", ":relative:");
      expect(await loginPath()).toEqual({
        path: ":relative:",
        warning: "Login shell PATH unavailable; using the inherited PATH.",
      });
      expect((await agentFixture.service.scan()).agents.every((agent) => agent.path === null)).toBe(
        true,
      );
      expect(access).not.toHaveBeenCalled();
      vi.stubEnv("PATH", undefined);
      expect((await loginPath()).path).toBe("");
    },
  );
  it.skipIf(process.platform === "win32")(
    "rejects an invalid shell and empty or malformed shell output",
    async () => {
      vi.mocked(userInfo).mockReturnValueOnce({
        uid: 1,
        gid: 1,
        username: "test",
        homedir: "/home/test",
        shell: null,
      });
      expect((await loginPath()).warning).not.toBeNull();
      vi.mocked(userInfo).mockReturnValueOnce({
        uid: 1,
        gid: 1,
        username: "test",
        homedir: "/home/test",
        shell: "relative",
      });
      expect((await loginPath()).warning).not.toBeNull();
      vi.mocked(execFile).mockImplementationOnce((_file, _args, _options, callback) => {
        if (typeof callback === "function") callback(null, "no marker", "");
        return new ChildProcess();
      });
      expect((await loginPath()).warning).not.toBeNull();
      expect(homedir).toHaveBeenCalled();
    },
  );
});

it("discards a discovery result when a loaded plugin changes during probing", async () => {
  const manifest = parseAgentManifest(JSON.stringify(pluginFixture)).model;
  const changed = v2Provider(manifest, () => Promise.resolve());
  const original = v2Provider(manifest, () => {
    replaceConfigProviders([changed]);
    return Promise.resolve();
  });
  replaceConfigProviders([original]);
  await expect(agentFixture.service.scan()).rejects.toThrow("Agent plugins changed. Scan again.");
  replaceConfigProviders([]);
  expect((await agentFixture.service.scan()).agents.some((agent) => agent.id === "claude")).toBe(
    true,
  );
});

it("v2 preserves successful discovery data when only the independent version probe fails", async () => {
  const { parseAgentManifest } = await import("../../../../src/shared/agent-plugin-parser");
  const { v2Provider } = await import("../../../../src/main/agents/providers/v2");
  const fixture = await import("../../../fixtures/agent-plugin-v2.json");
  const parsed = parseAgentManifest(
    JSON.stringify({
      ...fixture.default,
      files: [],
      discovery: { facts: fixture.default.discovery.facts },
      launch: { ...fixture.default.launch, mcp: undefined, toolPermissions: undefined },
    }),
  );
  replaceConfigProviders([v2Provider(parsed.model, () => Promise.resolve())]);
  agentFixture.help = "--inline --prompt";
  agentFixture.failed = "--version";
  agentFixture.service = new AgentService({ listWorktrees, launchIdentity }, { create });
  const scan = await agentFixture.service.scan();
  expect(scan.agents.find((agent) => agent.id === parsed.model.id)?.version).toBeNull();
  const result = await agentFixture.service.launch({
    ...request,
    agent: parsed.model.id,
    prompt: "a supported task",
  });
  expect(create.mock.calls.at(-1)?.[0].args.at(-1)).toContain("a supported task");
  agentFixture.service.release(result.id);
});

it("disabled agents retain card identity but run no discovery or setup probes, and enabling probes again", async () => {
  const scan = await agentFixture.service.scan({
    claude: false,
    codex: false,
    agy: false,
    pi: false,
  });
  expect(scan.agents.map((agent) => [agent.id, agent.path, agent.reason])).toEqual([
    ["claude", join(root, process.platform === "win32" ? "claude.exe" : "claude"), "Turned off"],
    ["codex", join(root, process.platform === "win32" ? "codex.exe" : "codex"), "Turned off"],
    ["agy", join(root, process.platform === "win32" ? "agy.exe" : "agy"), "Turned off"],
    ["pi", join(root, process.platform === "win32" ? "pi.exe" : "pi"), "Turned off"],
  ]);
  expect(scan.agents[0]?.name).toBe("Claude Code");
  expect(execFile).not.toHaveBeenCalledWith(
    expect.stringContaining("claude"),
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
  expect(execFile).not.toHaveBeenCalledWith(
    expect.stringContaining("codex"),
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
  expect(execFile).not.toHaveBeenCalledWith(
    expect.stringContaining("agy"),
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
  expect(
    (await agentFixture.service.scan({ claude: true, codex: false, agy: false })).agents[0]?.path,
  ).not.toBeNull();
});
