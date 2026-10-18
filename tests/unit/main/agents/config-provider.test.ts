import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../fixtures/agent-plugin.json";
import { parseAgentPlugin } from "../../../../src/shared/agent-manifest";
import { configProvider } from "../../../../src/main/agents/providers/config";
import {
  knownAgentId,
  replaceConfigProviders,
  providerRevision,
} from "../../../../src/main/agents/providers/registry";
import { hasBypassArgument } from "../../../../src/main/agents/default-arguments";
import { reduceEvent } from "../../../../src/main/agents/providers/hook-events";
import type { HookSession } from "../../../../src/main/agents/providers/hook-events";
import { prepareHookLaunch } from "../../../../src/main/agents/providers/hook-launch";
import { detectAgent } from "../../../../src/main/evaluator/agent-rules";
import { AgyPlugin } from "../../../../src/main/agents/agy-plugin";
import type { AgentHooks, AgentLaunch } from "../../../../src/shared/agents";
import { CONFIG_PROMPT } from "../../../../src/main/agents/providers/cli-launch";
import { resumeArguments } from "../../../../src/main/agents/conversation";
import { agentChoices, readyAgents } from "../../../../src/renderer/preflight/preflight";
import { setupState } from "../../../fixtures/setup";
import { launcherActions } from "../../../../src/renderer/board/sidebar-view";

const manifest = parseAgentPlugin(JSON.stringify(fixture));
const binding: AgentHooks = {
  observerCommand: "sh 'fixed observer'",
  observerArgv: ["sh", "fixed observer"],
  env: {},
  dispose: () => undefined,
};
const request: AgentLaunch = {
  agent: manifest.id,
  repository: "/fixture",
  worktree: "/fixture",
  cols: 80,
  rows: 24,
};
const roots: string[] = [];
afterEach(async () => {
  replaceConfigProviders([]);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("discovers validated manifest capabilities, constructs literal argv, resumes, and flags manifest-declared bypass arguments", async () => {
  const provider = configProvider(manifest, () => Promise.resolve());
  const installation = provider.discover("/fixture/agent", "1.0", "--observer --mcp");
  expect(installation).toMatchObject({
    name: manifest.name,
    mark: manifest.badge,
    reason: "Config-authored agent; validated launch manifest.",
    hooks: true,
    mcp: true,
  });
  expect(provider.discover("/fixture/agent", "1.0", "")).toMatchObject({
    hooks: false,
    mcp: false,
  });
  expect(await provider.enrich(installation, new AgyPlugin())).toEqual(installation);
  replaceConfigProviders([provider]);
  const revision = providerRevision();
  replaceConfigProviders([provider]);
  expect(providerRevision()).toBe(revision);
  expect(knownAgentId({ id: manifest.id })).toBe(false);
  expect(resumeArguments(manifest.id, "conversation-1")).toEqual(["--resume", "conversation-1"]);
  expect(() => provider.resume("--escape")).toThrow("Invalid conversation");
  expect(hasBypassArgument(manifest.id, ["--yolo"])).toBe(true);
  expect(hasBypassArgument(manifest.id, [])).toBe(false);
  const mcp = await provider.prepareMcp("http://127.0.0.1:1234/control/v1");
  expect(mcp.args[0]).toBe("--mcp");
  expect(mcp.args[1]).toBe("http://127.0.0.1:1234/mcp");
  expect(mcp.args[3]).toMatch(/^mcp__foom_[a-f0-9]+__open_preview$/u);
  mcp.dispose();
  const args = provider.arguments(
    installation,
    { ...request, prompt: "Literal {hookArgv} $(echo never)" },
    ["--default"],
    provider.resume("conversation-1"),
    binding,
    mcp,
    true,
    false,
  );
  expect(args).toEqual([
    "--default",
    "--literal",
    "$(must-not-execute)",
    "--resume",
    "conversation-1",
    "--observer",
    JSON.stringify(binding.observerArgv),
    ...mcp.args,
    "--prompt",
    "Task from your Foom orchestrator (another agent, not the user):\nBefore stopping when finished, blocked, or CI fails, report to your parent with handoff({ status: done|blocked|failed, summary, links?, idempotencyKey }), or foom handoff --status done|blocked|failed --summary-file FILE|- [--link HTTPS_URL] --idempotency-key KEY. Handoffs are pull-only; they never type into a terminal.\n\nLiteral {hookArgv} $(echo never)",
  ]);
  expect(
    provider.arguments(installation, request, [], [], undefined, undefined, false, false),
  ).toEqual(manifest.launch.arguments);
  expect(
    provider.arguments(installation, request, [], [], binding, undefined, false, true),
  ).toContain(CONFIG_PROMPT);
  expect(
    provider.arguments(
      installation,
      { ...request, conversationId: "conversation-1" },
      [],
      [],
      undefined,
      undefined,
      false,
      true,
    ),
  ).not.toContain(CONFIG_PROMPT);
  expect(provider.needsNotifier(installation, binding)).toBe(false);
  const report = { warning: null, agents: [installation] };
  expect(agentChoices(report)).toContainEqual({
    id: manifest.id,
    name: manifest.name,
    command: "foom-test-agent",
  });
  expect(readyAgents(report, setupState())).toEqual([installation]);
  expect(
    launcherActions(
      {
        agents: [installation],
        repositories: [],
        acknowledged: false,
        enabled: setupState().settings.agents,
        hooks: true,
      },
      "sh",
    )[0],
  ).toMatchObject({ label: manifest.name, badge: manifest.badge, run: manifest.id });
  expect(detectAgent(manifest.id, { title: "Fixture working", progress: null }, [])).toMatchObject({
    id: "working",
  });
  expect(() => {
    replaceConfigProviders([provider, provider]);
  }).toThrow("duplicate");
  expect(() => {
    replaceConfigProviders([{ ...provider, id: "claude" }]);
  }).toThrow("Reserved");
});
it("refuses invalid prompts and endpoints and unsupported resume/prompt templates", () => {
  const provider = configProvider(manifest, () => Promise.resolve());
  const installation = provider.discover("/agent", "1", "--observer");
  for (const prompt of ["", "-option", "\u0000", "x".repeat(16385)])
    expect(() =>
      provider.arguments(
        installation,
        { ...request, prompt },
        [],
        [],
        undefined,
        undefined,
        false,
        false,
      ),
    ).toThrow("Invalid initial prompt");
  for (const endpoint of [
    "https://127.0.0.1:1/control/v1",
    "http://localhost:1/control/v1",
    "http://127.0.0.1/control/v1",
    "http://127.0.0.1:1/wrong",
    "http://127.0.0.1:1/control/v1?q=x",
    "http://127.0.0.1:1/control/v1#hash",
    "http://user:password@127.0.0.1:1/control/v1",
  ])
    expect(() => provider.prepareMcp(endpoint)).toThrow("Invalid control endpoint");
  const minimal = parseAgentPlugin(
    JSON.stringify({
      ...fixture,
      launch: { arguments: [] },
      attention: { minimumEngineVersion: 1, rules: [] },
    }),
  );
  const plain = configProvider(minimal, () => Promise.resolve());
  expect(() => plain.resume("session")).toThrow("cannot resume");
  expect(() =>
    plain.arguments(
      installation,
      { ...request, prompt: "hello" },
      [],
      [],
      undefined,
      undefined,
      false,
      false,
    ),
  ).toThrow("cannot take");
});
it("maps only fixed top-level fields, pins conversation identity and discards arbitrary payload text", () => {
  const mapping = manifest.attention.hook;
  if (!mapping) throw Error("Missing fixture mapping");
  const session: HookSession = {
    terminalId: "fixture",
    agent: manifest.id,
    digest: Buffer.alloc(32),
    mapping,
  };
  expect(
    reduceEvent(session, {
      session: "conversation-1",
      event: "start",
      prompt: "untrusted instructions",
      transcript_path: "/never/read",
    }),
  ).toEqual({
    terminalId: "fixture",
    conversationId: "conversation-1",
    action: "working",
    signal: `plugin:${manifest.id}:start`,
  });
  expect(reduceEvent(session, { session: "conversation-1", event: "unknown" })).toBeUndefined();
  for (const value of [
    { session: "other", event: "start" },
    { session: "conversation-1", event: 1 },
    { session: "conversation-1", event: "x".repeat(65) },
    { session: "--bad", event: "start" },
  ])
    expect(() => reduceEvent(session, value)).toThrow();
  for (const [event, action] of Object.entries(manifest.attention.hook?.events ?? {}))
    expect(reduceEvent(session, { session: "conversation-1", event })?.action).toBe(action);
});
it("generates fixed stdin and argv observer adapters for a manifest without executing the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-manifest-observer-"));
  roots.push(root);
  const bind = vi.fn();
  const revoke = vi.fn();
  const receiver = {
    register: () => ({
      env: {
        FOOM_SESSION: "session",
        FOOM_TOKEN: "token",
        FOOM_HOOK_URL: "http://127.0.0.1:1/hooks",
      },
      revoke,
    }),
  };
  for (const transport of ["argv", "stdin"] as const) {
    const parsed = parseAgentPlugin(
      JSON.stringify({
        ...fixture,
        attention: { ...fixture.attention, hook: { ...fixture.attention.hook, transport } },
      }),
    );
    replaceConfigProviders([configProvider(parsed, () => Promise.resolve())]);
    const binding = await prepareHookLaunch(receiver, parsed.id, bind, "linux", root);
    const file = binding.observerArgv[1];
    if (!file) throw Error("Missing observer");
    const source = await readFile(file, "utf8");
    expect(source.includes("for payload do")).toBe(transport === "argv");
    binding.bind?.("terminal");
    binding.dispose();
    binding.dispose();
  }
  expect(revoke).toHaveBeenCalledTimes(2);
});
