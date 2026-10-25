import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import data from "../../../../src/shared/bundled-agents/copilot.json";
import claude from "../../../../src/shared/bundled-agents/claude.json";
import { bundledProvider } from "../../../../src/main/agents/providers/bundled";
import { agentProvider } from "../../../../src/main/agents/providers/registry";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import {
  hasBypassArgument,
  parseAgentArguments,
} from "../../../../src/main/agents/default-arguments";
import { bypassEnvironment } from "../../../../src/main/agents/providers/v2-values";
import { reduceV2 } from "../../../../src/main/agents/providers/v2-events";
import { prepareHookLaunch } from "../../../../src/main/agents/providers/hook-launch";
import { HookReceiver } from "../../../../src/main/agents/hook-receiver";
import { detectAgent } from "../../../../src/main/evaluator/agent-rules";
import { parseResume } from "../../../../src/renderer/board/resume-field";

const provider = agentProvider("copilot");
const help =
  "--plugin-dir <dir> --additional-mcp-config <json> --allow-tool <tool> --interactive <prompt> --session-id <id> --resume <id>";
const version = "GitHub Copilot CLI 1.0.103.\nRun 'copilot update' to check for updates.";
const request = { agent: "copilot", repository: "/repo", worktree: "/repo", cols: 100, rows: 32 };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("loads only locked data, reserves its identity and grants the same classified tools as Claude", () => {
  expect(provider.origin).toBe("bundled");
  expect(data.launch.toolPermissions.names).toEqual(claude.launch.toolPermissions.names);
  expect(() => parseAgentManifest(JSON.stringify(data))).toThrow("reserved-id");
  const digest = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  expect(() => bundledProvider({ ...data, name: "Changed" }, "copilot", digest)).toThrow(
    "integrity",
  );
  expect(Object.isFrozen(provider.model)).toBe(true);
});

it("gates capabilities on the measured stable version and complete help flags", () => {
  expect(provider.discover("/fixture", version, help)).toMatchObject({
    hooks: true,
    mcp: true,
    restoreControl: true,
  });
  for (const v of [
    "GitHub Copilot CLI 1.0.102.",
    "GitHub Copilot CLI 1.0.103-beta.",
    "unknown",
    "",
  ]) {
    expect(provider.discover("/fixture", v, help)).toMatchObject({
      hooks: false,
      mcp: false,
      restoreControl: false,
    });
  }
  expect(
    provider.discover("/fixture", version, "--plugin-directory --additional-mcp-config-other"),
  ).toMatchObject({ hooks: false, mcp: false });
});

it.each([false, true])(
  "assigns a session UUID and attaches isolated MCP/plugin data with hooks=%s",
  async (enabled) => {
    const receiver = await HookReceiver.listen(vi.fn());
    cleanups.push(() => receiver.close());
    const root = await mkdtemp(join(tmpdir(), "foom-copilot-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    // Synthetic executor covers Windows observer probing without running any agent.
    const hooks = enabled
      ? await prepareHookLaunch(receiver, "copilot", vi.fn(), process.platform, root, () =>
          Promise.resolve({
            stdout: "",
            stderr: "",
          }),
        )
      : undefined;
    if (hooks)
      cleanups.push(() => {
        hooks.dispose();
      });
    const installation = provider.discover("/fixture/copilot", version, help);
    const prepared = await provider.prepareLaunch(
      installation,
      { ...request, prompt: "Reply ready" },
      ["--model", "fixture", "--allow-tool", "shell(git status)"],
      {
        env: {
          FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1",
          FOOM_CONTROL_TOKEN: "not-in-files",
        },
        toolNames: ["manual", "handoff"],
        dispose: vi.fn(),
      },
      false,
      enabled,
      hooks,
    );
    cleanups.push(() => {
      prepared.dispose();
    });
    expect(prepared.conversationId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(prepared.args.slice(0, 2)).toEqual(["--model", "fixture"]);
    expect(prepared.args[prepared.args.indexOf("--session-id") + 1]).toBe(prepared.conversationId);
    expect(prepared.args.at(-2)).toBe("--interactive");
    expect(prepared.args.at(-1)).toContain("Reply ready");
    const file = prepared.args[prepared.args.indexOf("--additional-mcp-config") + 1]?.slice(1);
    if (!file) throw new Error("Missing MCP file");
    const content = await readFile(file, "utf8");
    expect(content).not.toContain("not-in-files");
    expect(content).toContain("Bearer ${FOOM_CONTROL_TOKEN}");
    const name = content.match(/foom_[a-f0-9]{32}/u)?.[0];
    if (!name) throw new Error("Missing server name");
    expect(prepared.args).toContain(`${name}(manual)`);
    expect(prepared.args).toContain(`${name}(handoff)`);
    expect(prepared.args).not.toContain(`${name}(launch)`);
    expect(prepared.args).toContain("shell(git status)");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    const plugin = prepared.args[prepared.args.indexOf("--plugin-dir") + 1];
    if (enabled) {
      if (!plugin) throw new Error("Missing plugin");
      expect(plugin).toBe(dirname(file));
      expect(JSON.parse(await readFile(join(plugin, "plugin.json"), "utf8"))).toEqual({
        name: "foom-observer",
        version: "1.0.0",
      });
      const config = await readFile(join(plugin, "hooks.json"), "utf8");
      expect(config).toContain("agentStop");
      expect(config).not.toContain("not-in-files");
      expect(hooks?.v2?.channels.size).toBe(1);
    } else expect(prepared.args).not.toContain("--plugin-dir");
    prepared.dispose();
    await expect(stat(file)).rejects.toThrow();
  },
);

it("resumes with the requested ID and no new ID, and falls back without unverified MCP/hooks", async () => {
  const installation = provider.discover("/fixture", version, help);
  const launch = await provider.prepareLaunch(
    installation,
    { ...request, conversationId: "session-1" },
    [],
    undefined,
    false,
    false,
  );
  cleanups.push(() => {
    launch.dispose();
  });
  expect(launch.args).toEqual(["--resume", "session-1"]);
  expect(launch.conversationId).toBeUndefined();
  expect(provider.resume("session-1")).toEqual(["--resume", "session-1"]);
  expect(
    parseResume(
      "copilot --resume session-1",
      data.resumePaste.map((pattern) => ({ ...pattern, agent: "copilot" })),
    ),
  ).toMatchObject({
    agent: "copilot",
    id: "session-1",
  });
  const unsupported = provider.discover("/fixture", "unknown", help);
  await expect(
    provider.prepareLaunch(
      unsupported,
      { ...request, prompt: "Reply ready" },
      [],
      undefined,
      false,
      false,
    ),
  ).rejects.toThrow("cannot take an initial prompt");
});

it("reduces measured header events, pins session identity and ignores pre-decision permission events", () => {
  const channel = provider.model.hooks?.channels[0];
  if (!channel) throw new Error("Missing channel");
  const state = {};
  for (const [event, action] of [
    ["sessionStart", "ready"],
    ["userPromptSubmitted", "working"],
    ["preToolUse", "working"],
    ["postToolUse", "working"],
    ["agentStop", "classify"],
  ]) {
    expect(
      reduceV2(
        channel,
        state,
        "terminal",
        "copilot",
        { sessionId: "session-1", transcriptPath: "never-read", prompt: "discard" },
        event,
        undefined,
      ),
    ).toMatchObject({ action, conversationId: "session-1" });
  }
  expect(
    reduceV2(
      channel,
      state,
      "terminal",
      "copilot",
      { sessionId: "session-1" },
      "permissionRequest",
      undefined,
    ),
  ).toBeUndefined();
  expect(() =>
    reduceV2(
      channel,
      state,
      "terminal",
      "copilot",
      { sessionId: "different" },
      "agentStop",
      undefined,
    ),
  ).toThrow();
  expect(() => reduceV2(channel, {}, "terminal", "copilot", {}, "agentStop", undefined)).toThrow();
  expect(JSON.stringify(state)).not.toContain("discard");
});

it.each(["--yolo", "--allow-all", "--allow-all-tools", "--allow-all-paths", "--allow-all-urls"])(
  "discloses %s and its equals form",
  (flag) => {
    expect(hasBypassArgument("copilot", [flag])).toBe(true);
    expect(hasBypassArgument("copilot", [`${flag}=true`])).toBe(true);
  },
);
it("matches documented environment truthy values and protects session/plugin/prompt selectors", () => {
  for (const value of ["true", "  YES ", "1", "On", "y"])
    expect(bypassEnvironment(provider.model, { COPILOT_ALLOW_ALL: value }, false).length > 0).toBe(
      true,
    );
  for (const value of ["false", "0", "off", "", "no"])
    expect(bypassEnvironment(provider.model, { COPILOT_ALLOW_ALL: value }, false).length > 0).toBe(
      false,
    );
  for (const args of [
    ["--plugin-dir", "/foreign"],
    ["--session-id=foreign"],
    ["-rforeign"],
    ["--continue"],
    ["--interactive", "foreign"],
  ])
    expect(() => parseAgentArguments("copilot", args)).toThrow("reserved");
});

it("keeps historical working/footer text and cancelled forms from masking the current screen", () => {
  const evidence = { title: "", progress: null };
  expect(
    detectAgent("copilot", evidence, ["● Working esc esc interrupt", "new output"])?.state,
  ).toBeUndefined();
  expect(
    detectAgent("copilot", evidence, [
      "Interactive · Manual Approval · / commands",
      "● Working esc esc interrupt",
    ])?.state,
  ).toBe("working");
  expect(
    detectAgent("copilot", evidence, [
      "● Working esc esc interrupt",
      "↑/↓ to navigate · enter to select · esc to cancel",
    ])?.state,
  ).toBe("blocked");
  expect(
    detectAgent("copilot", evidence, ["Interactive · Manual Approval · / commands"])?.state,
  ).toBe("idle");
});
