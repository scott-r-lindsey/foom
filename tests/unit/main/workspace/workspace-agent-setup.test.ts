import { ENABLED_AGENTS } from "../../../helpers/enabled-agents";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { AgyPlugin } from "../../../../src/main/agents/agy-plugin";
import { PluginSetup } from "../../../../src/main/agents/plugin-setup";
import { replaceConfigProviders } from "../../../../src/main/agents/providers/registry";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import { Workspace } from "../../../../src/main/workspace/workspace";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import setupFixture from "../../../fixtures/agent-plugins-v2/agy.json";
import { agents, configDep, deps, repo, scan, tree } from "./workspace-fixture";

test("caches agent scans until a refresh and retries after a failed scan", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  await expect(workspace.scanAgents(false)).resolves.toEqual({
    warning: null,
    agents: scan.agents,
  });
  await workspace.scanAgents(false);
  expect(agents.scan).toHaveBeenCalledOnce();
  await workspace.scanAgents(true);
  expect(agents.scan).toHaveBeenCalledTimes(2);
  agents.scan.mockRejectedValueOnce(new Error("probe"));
  await expect(workspace.scanAgents(true)).rejects.toThrow("probe");
  await workspace.scanAgents(false);
  expect(agents.scan).toHaveBeenCalledTimes(4);
  await workspace.scanAgents(true, "claude");
  expect(agents.scan).toHaveBeenLastCalledWith(expect.anything(), "claude");
});

test("preflight settings control hooks and which agents may launch", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  workspace.configure({ hooks: false, agents: { claude: false, codex: true, agy: true } });
  expect(agents.setHooksEnabled).toHaveBeenCalledWith(false);
  expect(agents.setEnabled).toHaveBeenLastCalledWith({ claude: false, codex: true, agy: true });
  expect(agents.setBypassIdentities).toHaveBeenCalledWith(undefined);
  const identities = { opencode: "a".repeat(64) };
  workspace.configure({
    hooks: false,
    agents: { claude: false, codex: true, agy: true },
    agentBypassIdentities: identities,
  });
  expect(agents.setBypassIdentities).toHaveBeenLastCalledWith(identities);
  await expect(
    workspace.launch({
      agent: "claude",
      repository: repo.path,
      worktree: tree.path,
      cols: 80,
      rows: 24,
    }),
  ).rejects.toThrow("turned off in preflight");
  expect(agents.launch).not.toHaveBeenCalled();
  workspace.configure({ hooks: true, agents: { claude: true, codex: true, agy: true } });
  await workspace.launch({
    agent: "claude",
    repository: repo.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
  });
  expect(agents.launch).toHaveBeenCalledOnce();
});

test("plugin operations resolve the CLI in main and invalidate discovery on both success and failure", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  const change = vi.spyOn(AgyPlugin.prototype, "change").mockResolvedValue();
  try {
    await expect(workspace.changeAgyPlugin("install")).rejects.toThrow(
      "Antigravity is not installed",
    );
    agents.scan.mockResolvedValue({
      ...scan,
      agents: [
        {
          id: "agy",
          path: "/resolved/agy",
          version: "1.3.1",
          hooks: false,
          reason: "plugin missing",
        },
      ],
    });
    const acknowledge = vi.fn(async () => {});
    deps.acknowledgeAgyPluginOffer = acknowledge;
    await workspace.changeAgyPlugin("install", () => Promise.resolve(false));
    expect(change).not.toHaveBeenCalled();
    expect(acknowledge).toHaveBeenCalledTimes(1);
    await workspace.changeAgyPlugin("install", () => Promise.resolve(true));
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(change).toHaveBeenCalledWith("/resolved/agy", "install");
    change.mockRejectedValueOnce(new Error("CLI failed"));
    await expect(workspace.changeAgyPlugin("remove")).rejects.toThrow("CLI failed");
    const count = agents.scan.mock.calls.length;
    await workspace.scanAgents(false);
    expect(agents.scan).toHaveBeenCalledTimes(count + 1);
  } finally {
    change.mockRestore();
    await workspace.dispose();
  }
});

test("v2 setup revalidates provider authority, resolves the executable in main and stages only in the profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-workspace-setup-"));
  const parsed = parseAgentManifest(JSON.stringify({ ...setupFixture, id: "setup-fixture" }));
  const model = parsed.model;
  model.hooks = undefined;
  model.files = [
    {
      name: "plugin.json",
      scope: "plugin",
      format: "json",
      content: '{"name":"foom"}',
      when: undefined,
    },
  ];
  const validate = vi.fn(() => Promise.resolve());
  const provider = v2Provider(model, validate);
  replaceConfigProviders([provider]);
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  const confirm = vi.fn(() => Promise.resolve(true));
  const change = vi.spyOn(PluginSetup.prototype, "change");
  try {
    await expect(workspace.changeAgentSetup("claude", "install", confirm)).rejects.toThrow(
      "unavailable",
    );
    await expect(workspace.changeAgentSetup(model.id, "install", confirm)).rejects.toThrow(
      "not installed",
    );
    agents.scan.mockResolvedValue({
      ...scan,
      agents: [
        {
          id: model.id,
          path: "/fixture/cli",
          version: "fixture",
          hooks: false,
          reason: "fixture",
          setup: { state: "not-installed", actions: [] },
        },
      ],
    });
    change.mockImplementationOnce(async (input) => {
      expect(input.executable).toBe("/fixture/cli");
      await input.validate();
      expect(input.facts()).toHaveProperty("healthTrusted", false);
      expect(() => input.stage()).toThrow("staging is unavailable");
      expect(await input.confirm({ title: "Install", accept: "Install" })).toBe(true);
    });
    await workspace.changeAgentSetup(model.id, "install", confirm);
    expect(validate).toHaveBeenCalled();
    change.mockImplementationOnce(function (this: PluginSetup) {
      this.result = "Installed Foom observer v5 · enabled";
      return Promise.resolve();
    });
    const result = await workspace.changeAgentSetup(model.id, "install", confirm);
    expect(result.agents.find((agent) => agent.id === model.id)?.setup?.result).toBe(
      "Installed Foom observer v5 · enabled",
    );
    change.mockImplementationOnce(function (this: PluginSetup) {
      this.result = "Install failed. Uninstalled the old version. Scan again.";
      return Promise.reject(Error("untrusted command output"));
    });
    expect(
      (await workspace.changeAgentSetup(model.id, "install", confirm)).agents.find(
        (agent) => agent.id === model.id,
      )?.setup?.result,
    ).toContain("Uninstalled the old version");
    change.mockRejectedValueOnce(Error("No receipt: preparation failed"));
    await expect(workspace.changeAgentSetup(model.id, "install", confirm)).rejects.toThrow(
      "preparation failed",
    );
    deps.pluginStagingRoot = root;
    change.mockImplementationOnce(async (input) => {
      const stage = await input.stage();
      expect(stage.directory.startsWith(root)).toBe(true);
      await stage.verify();
      agents.scan.mockResolvedValueOnce(scan);
      await expect(input.validate()).rejects.toThrow("executable changed");
      replaceConfigProviders([]);
      await expect(input.validate()).rejects.toThrow("plugin changed");
    });
    await workspace.changeAgentSetup(model.id, "install", confirm);
  } finally {
    change.mockRestore();
    replaceConfigProviders([]);
    await workspace.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("agent switches invalidate cached discovery while preserving launch preferences", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  await workspace.scanAgents(false);
  const preferences = {
    hooks: true,
    agents: { claude: false, codex: true, agy: true },
    agentArguments: { claude: ["--model", "saved"], codex: [], agy: [] },
  };
  workspace.configure(preferences);
  await workspace.scanAgents(false);
  expect(agents.scan).toHaveBeenCalledTimes(2);
  expect(agents.scan).toHaveBeenLastCalledWith(preferences.agents);
  workspace.configure(preferences);
  await workspace.scanAgents(false);
  expect(agents.scan).toHaveBeenCalledTimes(2);
  workspace.configure({ ...preferences, agents: { ...preferences.agents, claude: true } });
  await workspace.scanAgents(false);
  expect(agents.scan).toHaveBeenCalledTimes(3);
});

test("local installers use the bundled helper in a human recipe session without shell integration or a grant", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  await expect(workspace.startLocalAgentInstall("custom")).rejects.toThrow("unavailable");
  await expect(workspace.startLocalAgentInstall("codex")).rejects.toThrow("unavailable");
  const environment = vi.fn(() => [
    [{ name: "INSTALL_FIXTURE_SECRET_1071", value: "never-forward" }],
  ]);
  const configured = new Workspace({
    ...deps,
    environment,
    config: { ...configDep(), cliDirectory: "/fixture/console" },
  });
  configured.configure({ hooks: true, agents: ENABLED_AGENTS });
  configured.configure({ hooks: false, agents: { claude: false, codex: true, agy: true } });
  await expect(configured.startLocalAgentInstall("claude")).rejects.toThrow("unavailable");
  if (process.platform === "win32") {
    await expect(configured.startLocalAgentInstall("codex")).rejects.toThrow("unavailable");
    return;
  }
  const create = vi.spyOn(deps.terminals, "create");
  await configured.startLocalAgentInstall("codex");
  expect(environment).not.toHaveBeenCalled();
  expect(create.mock.calls.at(-1)?.[0].env).not.toHaveProperty("INSTALL_FIXTURE_SECRET_1071");
  expect(create.mock.calls.at(-1)?.[0].env).toMatchObject({ FOOM_SETTINGS_INSTALL: "1" });
  const installerEnv = create.mock.calls.at(-1)?.[0].env;
  expect(installerEnv?.["PATH"]).toBe("/login/bin");
  for (const name of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"]) {
    expect(installerEnv?.[name]).toBeTypeOf("string");
    expect(installerEnv?.[name]).not.toBe("");
  }
  expect(create).toHaveBeenLastCalledWith(
    expect.objectContaining({
      command: join("/fixture/console", "foom"),
      args: ["--install-agent", "codex"],
      replaceEnvironment: true,
    }),
  );
  expect(create).toHaveBeenLastCalledWith(expect.not.objectContaining({ shellIntegration: true }));
  expect(configured.snapshot().terminals.at(-1)).toMatchObject({
    recipe: true,
    kind: "shell",
    agent: "shell",
  });
});
