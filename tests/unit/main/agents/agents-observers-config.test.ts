import {
  agentFixture,
  binding,
  cleanup,
  create,
  launchIdentity,
  listWorktrees,
  prepare,
  request,
  root,
  versions,
} from "./agents-fixture";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { expect, it, vi } from "vitest";
import { AgentService } from "../../../../src/main/agents/agents";
import { PluginSetup } from "../../../../src/main/agents/plugin-setup";
import { CLI_GUIDANCE, CONFIG_PROMPT } from "../../../../src/main/agents/providers/cli-launch";
import {
  agentProvider,
  replaceConfigProviders,
} from "../../../../src/main/agents/providers/registry";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import { V2ExecutionHooks, V2Health } from "../../../../src/main/agents/providers/v2-health";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import pluginFixture from "../../../fixtures/agent-plugin.json";

it.each([true, false])(
  "Codex lifecycle launch preserves the notifier when observed trust is %s",
  async (trusted) => {
    const old = versions.codex;
    versions.codex = "codex-cli 0.161.0";
    agentFixture.service = new AgentService(
      { listWorktrees, launchIdentity },
      { create },
      prepare,
      () =>
        Promise.resolve({
          env: { FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1" },
          bind: vi.fn(),
          dispose: vi.fn(),
        }),
    );
    prepare.mockResolvedValueOnce({
      ...binding,
      v2: {
        values: binding.v2?.values ?? {},
        channels: new Map(),
        state: {},
        runtime: new V2ExecutionHooks(
          agentProvider("codex").model,
          new Map(),
          (() => {
            const health = new V2Health(root, "test", "definition");
            vi.spyOn(health, "get").mockReturnValue(trusted ? "trusted" : "not-reviewed");
            return health;
          })(),
        ),
      },
    });
    try {
      await agentFixture.service.launch({
        ...request,
        agent: "codex",
      });
      const args = create.mock.calls[0]?.[0].args ?? [];
      expect(args.filter((arg) => arg.startsWith("hooks."))).toHaveLength(6);
      expect(args).toContainEqual(
        expect.stringMatching(
          /^mcp_servers\.foom_[a-f0-9]+=\{url="http:\/\/127\.0\.0\.1:1234\/mcp",bearer_token_env_var="FOOM_CONTROL_TOKEN"\}$/u,
        ),
      );
      agentFixture.service.release("terminal-id");
      expect(cleanup).toHaveBeenCalledOnce();
      expect(args.some((arg) => arg.startsWith("notify="))).toBe(!trusted);
      expect(args.join(" ")).not.toContain("--dangerously-bypass-hook-trust");
      expect(args.join(" ")).not.toContain("secret");
    } finally {
      versions.codex = old;
      agentFixture.service.dispose();
    }
  },
);

it("does not suppress the notifier when lifecycle hooks cannot be attached", async () => {
  prepare.mockResolvedValueOnce(binding);
  await agentFixture.service.launch({ ...request, agent: "codex" });
  expect(create.mock.calls[0]?.[0].args).toContain(
    `notify=${JSON.stringify(binding.observerArgv)}`,
  );
});

it.each(["not-installed", "installed", "outdated", "disabled", "unavailable"] as const)(
  "Antigravity %s plugins gate launch credentials without adding agent arguments",
  async (state) => {
    const status = vi
      .spyOn(PluginSetup.prototype, "status")
      .mockResolvedValue({ state, actions: [] });
    try {
      const scan = await agentFixture.service.scan();
      expect(scan.agents.find((agent) => agent.id === "agy")?.setup).toEqual({
        state,
        actions: [],
      });
      const active = state === "installed" || state === "outdated";
      const result = await agentFixture.service.launch({ ...request, agent: "agy" });
      expect(result.attention).toBe(active ? "hooks" : "evaluator");
      expect(create.mock.calls[0]?.[0].args).toEqual([]);
      expect(create.mock.calls[0]?.[0].env?.["FOOM_TOKEN"]).toBe(active ? "secret" : undefined);
      agentFixture.service.release(result.id);
      agentFixture.service.setHooksEnabled(false);
      await agentFixture.service.launch({ ...request, agent: "agy" });
      expect(create.mock.calls[1]?.[0].env?.["FOOM_TOKEN"]).toBeUndefined();
    } finally {
      agentFixture.service.dispose();
      status.mockRestore();
    }
  },
);

it.each([false, true, "child"])(
  "launches Antigravity with process-local CLI PATH (orchestrator=%s)",
  async (orchestrator) => {
    agentFixture.help += "\n--prompt-interactive <prompt>";
    const inheritedPath = process.env["PATH"];
    agentFixture.service = new AgentService(
      { listWorktrees, launchIdentity },
      { create },
      prepare,
      () =>
        Promise.resolve({
          env: {
            FOOM_CLI_DIRECTORY: join(root, "console 日本語"),
            FOOM_CONTROL_TOKEN: "control-secret",
          },
          bind: vi.fn(),
          dispose: vi.fn(),
        }),
    );
    await agentFixture.service.launch({
      ...request,
      agent: "agy",
      defaultArguments: ["--prompt-interactive", "literal $(text)"],
      ...(orchestrator === "child"
        ? { control: { parentId: "parent" } }
        : orchestrator
          ? { control: { role: "orchestrator" as const } }
          : {}),
    });
    const spec = create.mock.calls.at(-1)?.[0];
    expect(spec?.args).toEqual(["--prompt-interactive", `literal $(text)\n\n${CLI_GUIDANCE}`]);
    expect(spec?.env?.["PATH"]).toBe(`${join(root, "console 日本語")}${delimiter}${root}`);
    expect(spec?.args.join(" ")).not.toContain("control-secret");
    expect(process.env["PATH"]).toBe(inheritedPath);
    expect(spec?.args.join(" ")).not.toMatch(/mcp_servers|--mcp-config/u);
  },
);

it("config launches skip worktree and control, keep hooks and put the CLI on PATH", async () => {
  const control = vi.fn(() => Promise.resolve({ env: {}, bind: vi.fn(), dispose: vi.fn() }));
  agentFixture.service = new AgentService(
    { listWorktrees, launchIdentity },
    { create },
    prepare,
    control,
  );
  const config = "/home/.foom/config";
  await agentFixture.service.launch({
    ...request,
    repository: config,
    worktree: config,
    configCli: "/app/console",
  });
  expect(listWorktrees).not.toHaveBeenCalled();
  expect(launchIdentity).not.toHaveBeenCalled();
  expect(control).not.toHaveBeenCalled();
  const spec = create.mock.calls.at(-1)?.[0];
  expect(spec?.cwd).toBe(config);
  expect(spec?.args).toContain("--settings");
  expect(spec?.env?.["PATH"]).toBe(`/app/console${delimiter}${root}`);
  expect(spec?.env?.["FOOM_CONTROL_TOKEN"]).toBeUndefined();
  agentFixture.service = new AgentService(
    { listWorktrees, launchIdentity },
    { create },
    prepare,
    control,
  );
  await agentFixture.service.launch({
    ...request,
    repository: config,
    worktree: config,
    configCli: "/app/console",
    environment: [[{ name: "PATH", value: "/opt/bin" }]],
  });
  expect(create.mock.calls.at(-1)?.[0].env?.["PATH"]).toBe(
    ["/app/console", "/opt/bin", root].join(delimiter),
  );
});

it("refuses orchestrators without a control binding", async () => {
  agentFixture.service = new AgentService({ listWorktrees, launchIdentity }, { create });
  await expect(
    agentFixture.service.launch({ ...request, control: { role: "orchestrator" } }),
  ).rejects.toThrow("control credentials");
});

it.each(["claude", "codex", "agy"] as const)(
  "greets fresh %s config sessions, including replacements, but never resumes",
  async (agent) => {
    agentFixture.help += "\n--prompt-interactive <prompt>";
    for (const conversationId of [undefined, "saved-id"]) {
      agentFixture.service = new AgentService(
        { listWorktrees, launchIdentity },
        { create },
        prepare,
      );
      await agentFixture.service.launch({
        ...request,
        agent,
        configCli: "/app/console",
        terminalId: "replacement",
        ...(conversationId === undefined ? {} : { conversationId }),
        defaultArguments:
          agent === "agy"
            ? [
                "--model",
                "test",
                "-i",
                "literal $(text)",
                "--prompt-interactive=another",
                "-i=third",
              ]
            : ["--model", "test"],
      });
      const args = create.mock.calls.at(-1)?.[0].args ?? [];
      expect(args).toContain("--model");
      expect(args).toContain("test");
      if (conversationId !== undefined) {
        expect(args.join("\n")).not.toContain(CONFIG_PROMPT);
        expect(args).toContain("saved-id");
      } else if (agent === "agy") {
        expect(args).toEqual([
          "--model",
          "test",
          "--prompt-interactive",
          `literal $(text)\n\nanother\n\nthird\n\n${CONFIG_PROMPT}`,
        ]);
      } else {
        expect(args.slice(-2)).toEqual(["--", CONFIG_PROMPT]);
        expect(args).toContain(agent === "claude" ? "--settings" : "-c");
      }
    }
  },
);

it("launches config Antigravity without a greeting when unsupported", async () => {
  await agentFixture.service.launch({
    ...request,
    agent: "agy",
    configCli: "/app/console",
    defaultArguments: ["--model", "test"],
  });
  expect(create.mock.calls.at(-1)?.[0].args).toEqual(["--model", "test"]);
});

it("releases a failed config greeting launch so it can be retried", async () => {
  agentFixture.help += "\n--prompt-interactive <prompt>";
  await expect(
    agentFixture.service.launch({
      ...request,
      agent: "agy",
      configCli: "/app/console",
      defaultArguments: ["-i"],
    }),
  ).rejects.toThrow("Merge option is missing its value");
  expect(create).not.toHaveBeenCalled();
  await agentFixture.service.launch({ ...request, agent: "agy", configCli: "/app/console" });
  expect(create.mock.calls.at(-1)?.[0].args).toEqual(["--prompt-interactive", CONFIG_PROMPT]);
});

it.each([
  { attached: true, defaults: [] },
  { attached: true, defaults: ["--model", "example"] },
  { attached: true, defaults: ["--allowedTools", "Read", "Bash(git log *)"] },
  {
    attached: true,
    defaults: ["--allowed-tools=Read,mcp__foom_test__open_preview", "--allowedTools", "Read"],
  },
  { attached: false, defaults: ["--allowedTools", "Read", "Bash(git log *)"] },
])("composes preview grants with defaults: $attached $defaults", async ({ attached, defaults }) => {
  const previous = versions.claude;
  versions.claude = "2.1.293 (Claude Code)";
  if (attached) agentFixture.help += "\n--mcp-config <file>";
  const grants = ["open_preview", "list_previews", "close_preview"].map(
    (tool) => `mcp__foom_test__${tool}`,
  );
  agentFixture.service = new AgentService(
    { listWorktrees, launchIdentity },
    { create },
    prepare,
    () =>
      Promise.resolve({
        env: { FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1" },
        bind: vi.fn(),
        dispose: vi.fn(),
      }),
  );
  agentFixture.service.setHooksEnabled(false);
  try {
    await agentFixture.service.launch({
      ...request,
      defaultArguments: defaults,
      prompt: "Show the mockup",
    });
    const args = create.mock.calls.at(-1)?.[0].args ?? [];
    if (attached) {
      const text = await readFile(args[args.indexOf("--mcp-config") + 1] ?? "", "utf8");
      const name = text.match(/foom_[a-f0-9]+/u)?.[0];
      if (!name) throw new Error("Missing MCP server");
      grants.splice(
        0,
        grants.length,
        ...["open_preview", "list_previews", "close_preview"].map(
          (tool) => `mcp__${name}__${tool}`,
        ),
      );
    }
    expect(args.slice(-2)).toEqual([
      "--",
      "Task from your Foom orchestrator (another agent, not the user):\nBefore stopping when finished, blocked, or CI fails, report to your parent with handoff({ status: done|blocked|failed, summary, links?, idempotencyKey }), or foom handoff --status done|blocked|failed --summary-file FILE|- [--link HTTPS_URL] --idempotency-key KEY. Handoffs are pull-only; they never type into a terminal.\n\nShow the mockup",
    ]);
    if (attached) {
      expect(args.filter((arg) => arg === "--allowedTools")).toHaveLength(1);
      expect(args).toEqual(expect.arrayContaining(grants));
      for (const grant of grants) expect(args.filter((arg) => arg === grant)).toHaveLength(1);
      if (defaults.some((arg) => arg.includes("Read"))) expect(args).toContain("Read");
      if (defaults.includes("Bash(git log *)")) expect(args).toContain("Bash(git log *)");
      if (defaults.includes("--model")) expect(args.slice(0, 2)).toEqual(["--model", "example"]);
    } else {
      expect(args.slice(0, -2)).toEqual(defaults);
      expect(args).not.toContain("--mcp-config");
    }
  } finally {
    versions.claude = previous;
  }
});

it("marks config-agent results as metadata on both normal launch and immediate exit", async () => {
  const manifest = parseAgentManifest(JSON.stringify(pluginFixture)).model;
  replaceConfigProviders([v2Provider(manifest, () => Promise.resolve())]);
  const launch = { ...request, agent: manifest.id };
  expect(await agentFixture.service.launch(launch)).toMatchObject({
    id: "terminal-id",
    providerOrigin: "config",
  });
  expect(create.mock.calls[0]?.[0].args).toEqual(manifest.launch.arguments?.arguments);
  agentFixture.service.release("terminal-id");
  create.mockImplementationOnce(() => {
    agentFixture.service.release("terminal-id");
    return "terminal-id";
  });
  expect(await agentFixture.service.launch(launch)).toMatchObject({
    id: "terminal-id",
    providerOrigin: "config",
  });
});

it("per-agent screen rules suppress only that agent's hooks and retain the global switch", async () => {
  agentFixture.service.setHooksEnabled(true, { claude: false });
  expect((await agentFixture.service.launch(request)).attention).toBe("evaluator");
  expect(prepare).not.toHaveBeenCalled();
  agentFixture.service.release("terminal-id");
  expect(
    (
      await agentFixture.service.launch({
        ...request,
        agent: "codex",
      })
    ).attention,
  ).toBe("hooks");
  expect(prepare).toHaveBeenCalledOnce();
  agentFixture.service.release("terminal-id");
  agentFixture.service.setHooksEnabled(true, { claude: true });
  expect((await agentFixture.service.launch(request)).attention).toBe("hooks");
  agentFixture.service.release("terminal-id");
  agentFixture.service.setHooksEnabled(false, { claude: true });
  expect((await agentFixture.service.launch(request)).attention).toBe("evaluator");
});

it.each([false, true])(
  "config Antigravity plugin receives manual bridge fields without control authority, hooks=%s",
  async (hooksEnabled) => {
    const status = vi
      .spyOn(PluginSetup.prototype, "status")
      .mockResolvedValue({ state: "installed", actions: [] });
    const previousVersion = versions.agy;
    versions.agy = "1.4.2";
    agentFixture.help = "--prompt-interactive <prompt>";
    if (hooksEnabled)
      prepare.mockResolvedValueOnce({
        ...binding,
        env: { ...binding.env, FOOM_SESSION: "00000000-0000-4000-8000-000000000001" },
      });
    const grant = vi.fn(() => Promise.resolve({ env: {}, bind: vi.fn(), dispose: vi.fn() }));
    agentFixture.service = new AgentService(
      { listWorktrees, launchIdentity },
      { create },
      prepare,
      grant,
    );
    agentFixture.service.setHooksEnabled(hooksEnabled, { agy: hooksEnabled });
    try {
      await agentFixture.service.launch({ ...request, agent: "agy", configCli: "/app/console" });
      const spec = create.mock.calls.at(-1)?.[0];
      expect(spec?.env?.["FOOM_CLI_DIRECTORY"]).toBe("/app/console");
      expect(spec?.env?.["FOOM_SESSION"]).toMatch(/^[a-f0-9-]{36}$/u);
      expect(spec?.env?.["FOOM_CONTROL_TOKEN"]).toMatch(/^[a-f0-9]{64}$/u);
      expect(spec?.env?.["FOOM_CONTROL_URL"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/control\/v1$/u);
      expect(spec?.env?.["FOOM_CONTROL_INSTANCE"]).toBeUndefined();
      expect(grant).not.toHaveBeenCalled();
      expect(listWorktrees).not.toHaveBeenCalled();
      expect(spec?.args.join("\n")).not.toContain(CLI_GUIDANCE);
      agentFixture.service.release("terminal-id");
    } finally {
      agentFixture.service.dispose();
      versions.agy = previousVersion;
      status.mockRestore();
    }
  },
);

it.each(["exit", "early-exit", "spawn-failure", "shutdown", "prepare-failure"])(
  "config manual attachments have no control grant and clean up on %s",
  async (outcome) => {
    const { ManualMcp } = await import("../../../../src/main/control/manual-mcp");
    const listen = vi.spyOn(ManualMcp, "listen");
    const grant = vi.fn(() => Promise.resolve({ env: {}, bind: vi.fn(), dispose: vi.fn() }));
    versions.claude = "2.1.300 (Claude Code)";
    agentFixture.help += "\n--mcp-config <file>";
    agentFixture.service = new AgentService(
      { listWorktrees, launchIdentity },
      { create },
      prepare,
      grant,
    );
    create.mockImplementation(() => {
      if (outcome === "spawn-failure") throw Error("spawn failed");
      if (outcome === "early-exit") agentFixture.service.release("terminal-id");
      return "terminal-id";
    });
    const configRequest = {
      ...request,
      configCli: "/app/console",
      ...(outcome === "prepare-failure" ? { prompt: "-invalid" } : {}),
    };
    try {
      if (outcome === "spawn-failure" || outcome === "prepare-failure")
        await expect(agentFixture.service.launch(configRequest)).rejects.toThrow();
      else await agentFixture.service.launch(configRequest);
      expect(grant).not.toHaveBeenCalled();
      expect(listWorktrees).not.toHaveBeenCalled();
      const attachment: unknown = await listen.mock.results[0]?.value;
      if (!(attachment instanceof ManualMcp)) throw Error("Missing manual attachment");
      expect(attachment.env["FOOM_CONTROL_INSTANCE"]).toBeUndefined();
      expect(attachment.env["FOOM_CLI_DIRECTORY"]).toBeUndefined();
      const url = attachment.url.replace("/control/v1", "/mcp");
      if (outcome === "exit" || outcome === "shutdown") {
        const spec = create.mock.calls.at(-1)?.[0];
        expect(spec?.env?.["FOOM_CONTROL_TOKEN"]).toBe(attachment.token);
        const permissions = spec?.args.filter((arg) => arg.startsWith("mcp__"));
        expect(permissions).toHaveLength(1);
        expect(permissions?.[0]).toMatch(/__manual$/u);
        const fileIndex = spec?.args.indexOf("--mcp-config") ?? -1;
        const file = spec?.args[fileIndex + 1];
        if (!file) throw Error("Missing private MCP file");
        expect(await readFile(file, "utf8")).toContain(url);
        if (outcome === "exit") agentFixture.service.release("terminal-id");
        else agentFixture.service.dispose();
        await vi.waitFor(async () => {
          await expect(readFile(file, "utf8")).rejects.toThrow();
        });
      }
      await expect(fetch(url)).rejects.toThrow();
    } finally {
      agentFixture.service.dispose();
      listen.mockRestore();
      versions.claude = "2.1.284 (Claude Code)";
    }
  },
);
