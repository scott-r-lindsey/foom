import { discoveryFacts } from "../../../../src/shared/agent-launch-values";
import captured from "../../../fixtures/agy-1.4.12-hooks.json";
import { reduceV2, type V2HookState } from "../../../../src/shared/agent-hook-events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readSessions } from "../../../../src/main/workspace/session-store";
import data from "../../../../src/shared/bundled-agents/agy.json";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import { PluginSetup } from "../../../../src/main/agents/plugin-setup";
import { prepareHookLaunch } from "../../../../src/main/agents/providers/hook-launch";
import { HookReceiver } from "../../../../src/main/agents/hook-receiver";
import {
  CHILD_PROMPT,
  CLI_GUIDANCE,
  CONFIG_PROMPT,
} from "../../../../src/main/agents/providers/cli-launch";
import type { AgentHooks } from "../../../../src/shared/agents";
import type { PreparedLaunch } from "../../../../src/main/agents/providers/provider";
import type { HookSignal } from "../../../../src/shared/hooks";
const provider = agentProvider("agy");
const request = { agent: "agy", repository: "/repo", worktree: "/repo", cols: 80, rows: 24 };
const control = { env: {}, bind: vi.fn(), dispose: vi.fn() };
afterEach(() => vi.restoreAllMocks());
it.each([false, true])(
  "preserves literal prompt merging, resume order and config greetings with control=%s",
  async (controlled) => {
    const installation = provider.discover("", "1.3.3", "--prompt-interactive <prompt>");
    expect(provider.origin).toBe("bundled");
    const launch = await provider.prepareLaunch(
      installation,
      { ...request, conversationId: "existing", prompt: "Fix it" },
      ["--model", "test", "-i", "literal $(text)", "loose", "--prompt-interactive=other"],
      controlled ? control : undefined,
      false,
      false,
    );
    expect(launch.args).toEqual([
      "--conversation",
      "existing",
      "--model",
      "test",
      ...(controlled
        ? [
            "loose",
            "--prompt-interactive",
            `literal $(text)\n\nother\n\n${CHILD_PROMPT}\n\nFix it\n\n${CLI_GUIDANCE}`,
          ]
        : [
            "-i",
            "literal $(text)",
            "loose",
            "--prompt-interactive=other",
            "--prompt-interactive",
            `${CHILD_PROMPT}\n\nFix it`,
          ]),
    ]);
    launch.dispose();
    const greeting = await provider.prepareLaunch(
      installation,
      request,
      ["-i", "-literal"],
      undefined,
      true,
      false,
    );
    expect(greeting.args).toEqual(["--prompt-interactive", `-literal\n\n${CONFIG_PROMPT}`]);
    greeting.dispose();
    const unsupported = provider.discover("", "1.0.0", "--other");
    await expect(
      provider.prepareLaunch(
        unsupported,
        { ...request, prompt: "Fix" },
        [],
        undefined,
        false,
        false,
      ),
    ).rejects.toThrow("cannot take an initial prompt");
  },
);

it("accepts installed channel-less observers only through their launch-bound protocol, validates before pinning, and revokes", async () => {
  vi.spyOn(PluginSetup.prototype, "status").mockResolvedValue({ state: "installed", actions: [] });
  const signals: HookSignal[] = [];
  const receiver = await HookReceiver.listen((signal) => signals.push(signal));
  const scratch = await mkdtemp(join(tmpdir(), "foom-bundled-test-"));
  let hooks: AgentHooks | undefined;
  let prepared: PreparedLaunch | undefined;
  try {
    hooks = await prepareHookLaunch(receiver, "agy", vi.fn(), process.platform, scratch);
    const installation = await provider.enrich(provider.discover("/fixture/agy", "1.3.3", ""));
    expect(installation.hooks).toBe(true);
    prepared = await provider.prepareLaunch(
      installation,
      request,
      [],
      undefined,
      false,
      true,
      hooks,
    );
    expect(prepared.args).toEqual([]);
    const post = async (
      event: string,
      sequence: string,
      fields: Record<string, unknown> = {},
      channel?: string,
    ) => {
      const response = await fetch(hooks?.env["FOOM_HOOK_URL"] ?? "", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: hooks?.env["FOOM_TOKEN"] ?? "",
          "X-Foom-Session": hooks?.env["FOOM_SESSION"] ?? "",
          "X-Foom-Event": event,
          "X-Foom-Sequence": sequence,
          ...(channel === undefined ? {} : { "X-Foom-Channel": channel }),
        },
        body: JSON.stringify({ conversationId: "existing", ...fields }),
      });
      await response.text();
      return response.status;
    };
    expect(
      await post("Stop", "1", {
        terminationReason: "unknown",
        fullyIdle: true,
        conversationId: "poison",
      }),
    ).toBe(400);
    expect(await post("PreInvocation", "1", {}, "unknown")).toBe(400);
    expect(await post("PreInvocation", "0")).toBe(400);
    expect(
      await post("Stop", "2", {
        terminationReason: "NO_TOOL_CALL",
        fullyIdle: true,
        prompt: "private",
      }),
    ).toBe(204);
    expect(await post("PostToolUse", "1")).toBe(204);
    expect(signals.map(({ action }) => action)).toEqual(["classify"]);
    expect(JSON.stringify(signals)).not.toContain("private");
    expect(await post("PreInvocation", "3", { conversationId: "foreign" })).toBe(400);
    hooks.dispose();
    expect(await post("PreInvocation", "3")).toBe(401);
  } finally {
    prepared?.dispose();
    hooks?.dispose();
    await receiver.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

it.each([
  ["placement", "launch"],
  ["transport", "argv-last"],
  ["version", 6],
  ["response", "silent"],
  ["delivery", "foreground"],
  ["timeoutMs", 2000],
  ["sequence", false],
  ["commandArguments", ["extra"]],
  ["protocol", "unknown"],
])("rejects incompatible legacy observer %s", (key, value) => {
  const draft = structuredClone(data);
  Reflect.set(draft.hooks.channels[0]?.observer ?? {}, key, value);
  expect(() => parseAgentManifest(JSON.stringify(draft), "bundled")).toThrow();
});

it("retains origin-less Antigravity session IDs and accepts only the bundled persisted origin", () => {
  const row = {
    id: "terminal",
    agent: "agy",
    repository: "/repo",
    worktree: "/repo",
    branch: "work",
    conversationId: "saved",
  };
  expect(readSessions([row])[0]?.conversationId).toBe("saved");
  expect(readSessions([{ ...row, providerOrigin: "bundled" }])[0]?.providerOrigin).toBe("bundled");
  expect(() => readSessions([{ ...row, providerOrigin: "config" }])).toThrow("Invalid");
});

it.each(["not-installed", "outdated", "disabled", "unavailable", "installed"] as const)(
  "uses plugin MCP only for a current intact installation: %s",
  async (state) => {
    vi.spyOn(PluginSetup.prototype, "status").mockResolvedValue({ state, actions: [] });
    const installation = await provider.enrich(
      provider.discover("/fixture/agy", "1.4.2", "--prompt-interactive"),
    );
    const launch = await provider.prepareLaunch(
      installation,
      request,
      [],
      {
        ...control,
        env: { FOOM_CONTROL_URL: "http://127.0.0.1:12345/control/v1" },
      },
      false,
      false,
    );
    expect(installation.mcp).toBe(state === "installed");
    expect(launch.mcp).toBe(state === "installed");
    expect(launch.args.join(" ").includes(CLI_GUIDANCE)).toBe(state !== "installed");
    launch.dispose();
    const old = await provider.enrich(
      provider.discover("/fixture/agy", "1.3.1", "--prompt-interactive"),
    );
    expect(old.mcp).toBe(false);
  },
);

it("reduces agy 1.4.12 tool and no-tool shapes, keeping only lifecycle facts", () => {
  const channel = provider.model.hooks?.channels[0];
  if (!channel) throw Error("Missing channel");
  const state: V2HookState = {};
  const signals: HookSignal[] = [];
  for (const [index, entry] of captured.events.entries()) {
    const signal = reduceV2(
      channel,
      state,
      "terminal",
      "agy",
      { ...captured.common, ...entry.fields },
      entry.event,
      String(index + 1),
    );
    expect(signal?.action).toBe(entry.action);
    expect(signal?.conversationId).toBe(captured.common.conversationId);
    if (signal) signals.push(signal);
  }
  expect(signals.at(-1)).toMatchObject({
    fullyIdle: true,
    terminationReason: "model_stop",
    recoverTurn: true,
  });
  for (const privateValue of [
    "private fixture prompt",
    "/private-tool-input",
    "/must-not-read",
    "fixture-model",
    "ReadFile",
  ])
    expect(JSON.stringify(signals)).not.toContain(privateValue);
  expect(
    reduceV2(channel, state, "terminal", "agy", { ...captured.common }, "PreToolUse", "1"),
  ).toBeUndefined();
  expect(() =>
    reduceV2(
      channel,
      state,
      "terminal",
      "agy",
      { ...captured.common, conversationId: "foreign" },
      "PreToolUse",
      "11",
    ),
  ).toThrow();
});
it.each(["1.4.2", "1.4.11", "1.4.12"])("retains compatible discovery for agy %s", (version) => {
  expect(
    discoveryFacts(provider.model, version, "--prompt-interactive", { setupState: "installed" }),
  ).toMatchObject({ hookSupport: true, pluginMcp: true });
});
