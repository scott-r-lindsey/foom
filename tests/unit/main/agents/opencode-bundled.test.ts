import { afterEach, expect, it, vi } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import data from "../../../../src/shared/bundled-agents/opencode.json";
import claude from "../../../../src/shared/bundled-agents/claude.json";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import { prepareV2Hooks } from "../../../../src/main/agents/providers/v2-hook-launch";
import { HookReceiver } from "../../../../src/main/agents/hook-receiver";
import { detectAgent } from "../../../../src/main/evaluator/agent-rules";
import {
  hasBypassArgument,
  parseAgentArguments,
} from "../../../../src/main/agents/default-arguments";
import { readSessions } from "../../../../src/main/workspace/session-store";
import { restorePlan, restoreAuthority } from "../../../../src/main/workspace/session-restore";
import type { AgentLaunch } from "../../../../src/shared/agents";
const provider = agentProvider("opencode");
const help = "--standalone --session --prompt --auto";
const request: AgentLaunch = {
  agent: "opencode",
  repository: "/repo",
  worktree: "/repo",
  cols: 120,
  rows: 40,
};
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it("ships locked data with fixed discovery and no config identity collision", () => {
  expect(provider.origin).toBe("bundled");
  expect(provider.discover("/fixture/opencode", "opencode v2.0.32", help)).toMatchObject({
    hooks: true,
    mcp: true,
    restoreControl: true,
  });
  for (const [version, output] of [
    ["opencode v2.0.31", help],
    ["2.0.32", help],
    ["opencode v2.0.32-beta", help],
    ["opencode v2.0.32", "--standalone --session-unknown --prompt"],
  ]) {
    expect(provider.discover("/fixture/opencode", version ?? "", output ?? "")).toMatchObject({
      hooks: false,
      mcp: false,
      restoreControl: false,
    });
  }
  expect(() => parseAgentManifest(JSON.stringify(data))).toThrow("reserved-id");
  const copy = v2Provider(
    parseAgentManifest(JSON.stringify({ ...data, id: "opencode-custom" })).model,
    () => Promise.resolve(),
  );
  expect(copy.origin).toBe("config");
  expect(copy.resume("ses_existing")).toEqual(["--session", "ses_existing"]);
  expect(data.launch.toolPermissions.names).toEqual(claude.launch.toolPermissions.names);
});
it.each([true, false])(
  "isolates config files, event adapters and scoped MCP with hooks=%s",
  async (hooks) => {
    const signals = vi.fn();
    const receiver = await HookReceiver.listen(signals);
    cleanups.push(() => receiver.close());
    const installation = provider.discover("/fixture/opencode", "opencode v2.0.32", help);
    const binding = hooks
      ? await prepareV2Hooks(receiver, provider.model, () => {}, false, tmpdir())
      : undefined;
    if (binding) cleanups.push(() => binding.disposeAndWait());
    const control = {
      env: {
        FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1",
        FOOM_CONTROL_TOKEN: "never-in-files",
      },
      bind: vi.fn(),
      dispose: vi.fn(),
      toolNames: ["manual", "handoff"],
    };
    const prepared = await provider.prepareLaunch(
      installation,
      { ...request, prompt: "Reply ready" },
      [],
      control,
      false,
      hooks,
      binding,
    );
    cleanups.push(() => {
      prepared.dispose();
    });
    expect(prepared.conversationId).toMatch(/^ses_[a-f0-9-]{36}$/u);
    expect(prepared.args.slice(0, 3)).toEqual([
      "--session",
      prepared.conversationId,
      "--standalone",
    ]);
    expect(prepared.args.at(-2)).toBe("--prompt");
    expect(prepared.args.at(-1)).toContain("Reply ready");
    expect(prepared.args).not.toContain("--auto");
    const content = prepared.environment?.find(
      (entry) => entry.name === "OPENCODE_CONFIG_CONTENT",
    )?.value;
    expect(content).toContain("Bearer {env:FOOM_CONTROL_TOKEN}");
    expect(content).not.toContain("never-in-files");
    const parsed: unknown = JSON.parse(content ?? "{}");
    const server = content?.match(/foom_[a-f0-9]{32}/u)?.[0];
    expect(parsed).toEqual({
      mcp: {
        servers: {
          [server ?? ""]: {
            type: "remote",
            url: "http://127.0.0.1:1234/mcp",
            oauth: false,
            codemode: false,
            headers: { Authorization: "Bearer {env:FOOM_CONTROL_TOKEN}" },
          },
        },
      },
      permissions: [
        { action: `${server ?? ""}_manual`, resource: "*", effect: "allow" },
        { action: `${server ?? ""}_handoff`, resource: "*", effect: "allow" },
      ],
    });
    const config = prepared.environment?.find((entry) => entry.name === "OPENCODE_CONFIG")?.value;
    if (hooks) {
      expect(binding?.v2?.state.conversation).toBe(prepared.conversationId);
      expect(binding?.v2?.channels.size).toBe(1);
      const text = await readFile(config ?? "", "utf8");
      const moduleRoot = binding?.v2?.values["observerModule:lifecycle"];
      expect(text).toContain(String(moduleRoot).replaceAll("\\", "\\\\"));
      const source = await readFile(`${String(moduleRoot)}/index.mjs`, "utf8");
      expect(source).toContain("context.event.subscribe");
      expect(source).not.toContain(binding?.env["FOOM_TOKEN"]);
      if (process.platform !== "win32") expect((await stat(config ?? "")).mode & 0o777).toBe(0o600);
      prepared.dispose();
      await expect(stat(config ?? "")).rejects.toThrow();
    } else expect(config).toBeUndefined();
  },
);
it("keeps ordinary launch permissions and reserves selectors and connection overrides", async () => {
  const installation = provider.discover("/fixture/opencode", "opencode v2.0.32", help);
  const result = await provider.prepareLaunch(
    installation,
    { ...request, conversationId: "ses_saved" },
    [],
    undefined,
    false,
    false,
  );
  cleanups.push(() => {
    result.dispose();
  });
  expect(result.args).toEqual(["--session", "ses_saved", "--standalone"]);
  expect(result.environment).toEqual([]);
  for (const flag of [
    "--session",
    "--session=ses_other",
    "-sother",
    "--continue",
    "-c",
    "--server=http://elsewhere",
    "--standalone=false",
    "--prompt=override",
  ])
    expect(() => parseAgentArguments("opencode", [flag])).toThrow();
  expect(hasBypassArgument("opencode", ["--auto"])).toBe(true);
  expect(hasBypassArgument("opencode", ["--auto=false"])).toBe(true);
  expect(hasBypassArgument("opencode", [])).toBe(false);
});
it("matches captured working, question and idle regions with blockers first", () => {
  const metadata = { title: "OC | Ready response", progress: null };
  const idle = [
    "┃ Build · qwen3:14b Ollama",
    "╹━━━━━━━━",
    "/tmp/scratch 7.2K (18%) ctrl+p commands",
  ];
  expect(detectAgent("opencode", metadata, idle)).toMatchObject({ state: "idle" });
  expect(
    detectAgent("opencode", metadata, [
      ...idle,
      "⬝⬝■■ esc interrupt shift+tab agents ctrl+p commands",
    ]),
  ).toMatchObject({ state: "working" });
  expect(
    detectAgent("opencode", metadata, [
      ...idle,
      "esc interrupt",
      "┃ Questions",
      "┃ ↑↓ select  enter submit  esc dismiss",
    ]),
  ).toMatchObject({ state: "blocked" });
  expect(detectAgent("opencode", metadata, ["ordinary text"])).toBeUndefined();
});
it("retains former config conversations dormant without inheriting bundled restore authority", () => {
  const row = {
    id: "terminal",
    agent: "opencode",
    repository: "/repo",
    worktree: "/repo",
    branch: "main",
    providerOrigin: "config",
    conversationId: "ses_saved",
    running: true,
    orchestrator: { identity: "identity", history: [] },
  };
  const entries = readSessions([row]);
  expect(entries[0]).toMatchObject({
    providerOrigin: "config",
    conversationId: "ses_saved",
    dormant: true,
  });
  expect(restorePlan(entries, true)).toEqual([]);
  const entry = entries[0];
  if (!entry) throw Error("Missing row");
  expect(
    restoreAuthority(
      entry,
      "identity",
      provider.discover("/fixture/opencode", "opencode v2.0.32", help),
      true,
    ),
  ).toBe(false);
  expect(restorePlan([{ ...entry, providerOrigin: "bundled" }], true)).toHaveLength(1);
});

it("isolated verification receives only ping, and renamed copies retain the same module engine", async () => {
  const parsed = parseAgentManifest(JSON.stringify({ ...data, id: "opencode-custom" }));
  const copy = v2Provider(parsed.model, () => Promise.resolve(), true);
  const installation = copy.discover("/fixture/opencode", "opencode v2.0.32", help);
  const prepared = await copy.prepareLaunch(
    installation,
    { ...request, agent: copy.id },
    [],
    { env: { FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1" }, dispose: () => {} },
    false,
    false,
  );
  cleanups.push(() => {
    prepared.dispose();
  });
  const content =
    prepared.environment?.find((entry) => entry.name === "OPENCODE_CONFIG_CONTENT")?.value ?? "";
  expect(content).toContain("_ping");
  expect(content).not.toContain("_launch");
});

it("maps form and execution identities on one ordered channel and rejects mixed sessions", async () => {
  const { reduceV2 } = await import("../../../../src/main/agents/providers/v2-events");
  const { probeHookEvent } = await import("../../../../src/main/agents/probe-events");
  const channel = provider.model.hooks?.channels[0];
  if (!channel) throw Error("Missing channel");
  const state = { conversation: "ses_expected" };
  const form = {
    id: "evt_form",
    type: "form.created",
    data: { form: { sessionID: "ses_expected" } },
  };
  expect(
    reduceV2(channel, state, "terminal", "opencode", form, undefined, undefined),
  ).toMatchObject({ action: "needs_input", conversationId: "ses_expected" });
  expect(
    reduceV2(channel, state, "terminal", "opencode", form, undefined, undefined),
  ).toBeUndefined();
  expect(
    probeHookEvent(channel, form, undefined, undefined, "ses_expected", undefined)
      .sessionMatchesNewId,
  ).toBe(true);
  expect(probeHookEvent(channel, form, undefined, undefined, "ses_expected", undefined).event).toBe(
    "form.created",
  );
  const conflict = {
    ...form,
    id: "evt_conflict",
    data: { ...form.data, sessionID: "ses_foreign" },
  };
  expect(() =>
    reduceV2(channel, state, "terminal", "opencode", conflict, undefined, undefined),
  ).toThrow("Conflicting conversation");
  expect(
    probeHookEvent(channel, conflict, undefined, undefined, "ses_expected", undefined)
      .sessionMatchesNewId,
  ).toBe(false);
});
