import { mcpTools } from "../../../../src/shared/control-tools";
import { CONTROL_TOOL_CLASSES } from "../../../../src/shared/control-tool-classes";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import data from "../../../../src/shared/bundled-agents/claude.json";
import { bundledProvider, bundledProviders } from "../../../../src/main/agents/providers/bundled";
import {
  agentProvider,
  replaceConfigProviders,
} from "../../../../src/main/agents/providers/registry";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import type { AgentHooks, AgentLaunch } from "../../../../src/shared/agents";
import { readSessions } from "../../../../src/main/workspace/session-store";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const request: AgentLaunch = {
  agent: "claude",
  repository: "/repo",
  worktree: "/repo",
  cols: 80,
  rows: 24,
};
const provider = agentProvider("claude");
function binding(): AgentHooks {
  return {
    observerCommand: "",
    observerArgv: [],
    env: {},
    dispose: vi.fn(),
    v2: {
      values: { "observerCommand:lifecycle": "sh '/private/observer.sh'" },
      channels: new Map(),
      state: {},
    },
  };
}

it("accepts only locked v2 build inputs and immutable data, never JSON-declared provenance", () => {
  expect(bundledProviders).toContain(provider);
  expect(provider.origin).toBe("bundled");
  expect(Object.isFrozen(provider.model.hooks?.channels)).toBe(true);
  const tampered = { ...data, executables: ["unexpected"] };
  expect(() => bundledProvider(tampered, "claude", digest(data))).toThrow("integrity");
  expect(() => bundledProvider(data, "another", digest(data))).toThrow("identity");
  const unsupported = { ...data, version: 1 };
  expect(() => bundledProvider(unsupported, "claude", digest(unsupported))).toThrow(
    "use version 2",
  );
  const provenance = { ...data, origin: "bundled" };
  expect(() => bundledProvider(provenance, "claude", digest(provenance))).toThrow("unknown-key");
  expect(() => parseAgentManifest(JSON.stringify(data))).toThrow("reserved-id");
  expect(() => {
    replaceConfigProviders([provider]);
  }).toThrow("Reserved");
  expect(agentProvider("claude")).toBe(provider);
});

it("launches a complete renamed copy on the same engine without carrying bundled authority", async () => {
  const parsed = parseAgentManifest(JSON.stringify({ ...data, id: "claude-custom" }));
  const copy = v2Provider(parsed.model, () => Promise.resolve());
  expect(copy.origin).toBe("config");
  const installation = provider.discover(
    "/fixture/claude",
    "2.1.293 (Claude Code)",
    "--settings --mcp-config",
  );
  const copyInstallation = copy.discover(
    "/fixture/claude",
    "2.1.293 (Claude Code)",
    "--settings --mcp-config",
  );
  const original = await provider.prepareLaunch(
    installation,
    request,
    ["--model", "test"],
    undefined,
    false,
    true,
    binding(),
  );
  const duplicate = await copy.prepareLaunch(
    copyInstallation,
    { ...request, agent: copy.id },
    ["--model", "test"],
    undefined,
    false,
    true,
    binding(),
  );
  try {
    expect(duplicate.args).toEqual(original.args);
  } finally {
    original.dispose();
    duplicate.dispose();
  }
});

it.each([false, true])(
  "preserves exact resume/default/MCP/tool/settings/prompt bytes with hooks=%s",
  async (hooks) => {
    const installation = provider.discover(
      "/fixture/claude",
      "2.1.293 (Claude Code)",
      "--settings --mcp-config",
    );
    const control = {
      env: {
        FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1",
        FOOM_CONTROL_TOKEN: "never-in-files",
      },
      bind: vi.fn(),
      dispose: vi.fn(),
    };
    const prepared = await provider.prepareLaunch(
      installation,
      { ...request, conversationId: "existing-session", prompt: "Fix it" },
      [
        "--allowed-tools=Read,Edit",
        "--model",
        "test",
        "--allowedTools",
        "Bash(git log *, git diff *)",
        "Read",
      ],
      control,
      false,
      hooks,
      hooks ? binding() : undefined,
    );

    const file = prepared.args[prepared.args.indexOf("--mcp-config") + 1] ?? "";
    try {
      expect(prepared.mcpArguments).toEqual(["--mcp-config", file]);
      const content = await readFile(file, "utf8");
      const name = content.match(/foom_[a-f0-9]+/u)?.[0];
      if (!name) throw new Error("Missing random server");
      expect(content).toBe(
        JSON.stringify({
          mcpServers: {
            [name]: {
              type: "http",
              url: "http://127.0.0.1:1234/mcp",
              headers: { Authorization: "Bearer ${FOOM_CONTROL_TOKEN}" },
            },
          },
        }),
      );
      const hook = [{ hooks: [{ type: "command", command: "sh '/private/observer.sh'" }] }];
      const settings = JSON.stringify({
        hooks: {
          UserPromptSubmit: hook,
          PreToolUse: hook,
          Stop: hook,
          PermissionRequest: hook,
          Notification: hook,
        },
      });
      expect(prepared.args).toEqual([
        "--resume",
        "existing-session",
        "--model",
        "test",
        "--mcp-config",
        file,
        "--allowedTools",
        "Read",
        "Edit",
        "Bash(git log *, git diff *)",
        ...mcpTools(1, []).map(({ name: tool }) => `mcp__${name}__${tool}`),
        ...(hooks ? ["--settings", settings] : []),
        "--",
        "Task from your Foom orchestrator (another agent, not the user):\nBefore stopping when finished, blocked, or CI fails, report to your parent with handoff({ status: done|blocked|failed, summary, links?, idempotencyKey }), or foom handoff --status done|blocked|failed --summary-file FILE|- [--link HTTPS_URL] --idempotency-key KEY. Handoffs are pull-only; they never type into a terminal.\n\nFix it",
      ]);
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      prepared.dispose();
    }
    await expect
      .poll(() =>
        stat(file).then(
          () => false,
          () => true,
        ),
      )
      .toBe(true);
  },
);

it("preserves legacy session identities and accepts only matching persisted origin", () => {
  const row = {
    id: "terminal",
    agent: "claude",
    repository: "/repo",
    worktree: "/repo",
    branch: "work",
    conversationId: "existing-session",
  };
  expect(readSessions([row])[0]?.conversationId).toBe("existing-session");
  expect(readSessions([{ ...row, providerOrigin: "bundled" }])[0]?.providerOrigin).toBe("bundled");
  expect(() => readSessions([{ ...row, providerOrigin: "config" }])).toThrow("Invalid");
  expect(() => readSessions([{ ...row, agent: "unknown", providerOrigin: "bundled" }])).toThrow(
    "Invalid",
  );
});

// Deliberate review boundary: a new registered tool must be classified and granted explicitly.
it("classifies every real server tool and includes every classification in the bundled grant", () => {
  const registered = mcpTools(1, [])
    .map(({ name }) => name)
    .sort();
  expect(registered).toEqual(Object.keys(CONTROL_TOOL_CLASSES).sort());
  expect([...data.launch.toolPermissions.names].sort()).toEqual(registered);
  expect(CONTROL_TOOL_CLASSES).toEqual({
    manual: "read",
    whoami: "read",
    sessions: "read",
    session_state: "read",
    open_preview: "preview",
    list_previews: "preview",
    close_preview: "preview",
    handoff: "child",
    read_handoff: "orchestration",
    create_worktree: "orchestration",
    launch: "orchestration",
    prompt: "orchestration",
    send_keys: "orchestration",
    stop: "orchestration",
    close: "orchestration",
    remove_worktree: "orchestration",
    tail: "orchestration",
    board_threads: "orchestration",
    board_read: "orchestration",
    board_post: "orchestration",
    board_resolve: "orchestration",
    wait_for: "orchestration",
    operation_status: "orchestration",
  });
});

it.each([
  { defaults: [] },
  { defaults: ["--model", "fixture"] },
  {
    defaults: [
      "--allowedTools",
      "Read",
      "Bash(git status, git log)",
      "--allowed-tools=Read,mcp__other__custom",
      "--disallowedTools",
      "mcp__*__stop",
    ],
  },
])(
  "grants only the attached Foom server and preserves user defaults $defaults",
  async ({ defaults }) => {
    const installation = provider.discover("/fixture/claude", "2.1.293", "--mcp-config");
    for (const attached of [false, true]) {
      const prepared = await provider.prepareLaunch(
        installation,
        request,
        defaults,
        attached
          ? {
              env: { FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1" },
              dispose: vi.fn(),
            }
          : undefined,
        false,
        false,
      );

      try {
        if (!attached) {
          expect(prepared.args).toEqual(defaults);
          continue;
        }
        const file = prepared.mcpArguments?.[1];
        if (!file) throw new Error("Missing attachment");
        const name = (await readFile(file, "utf8")).match(/foom_[a-f0-9]{32}/u)?.[0];
        if (!name) throw new Error("Missing server name");
        expect(prepared.args.filter((arg) => arg.startsWith("mcp__foom_"))).toEqual(
          mcpTools(1, []).map(({ name: tool }) => `mcp__${name}__${tool}`),
        );
        expect(prepared.args.filter((arg) => arg === "--allowedTools")).toHaveLength(1);
        expect(prepared.args).not.toContain("mcp__*");
        expect(prepared.args).not.toContain("--dangerously-skip-permissions");
        if (defaults.includes("Read")) {
          expect(prepared.args.filter((arg) => arg === "Read")).toHaveLength(1);
          expect(prepared.args).toContain("Bash(git status, git log)");
          expect(prepared.args).toContain("mcp__other__custom");
          expect(prepared.args[prepared.args.indexOf("--disallowedTools") + 1]).toBe(
            "mcp__*__stop",
          );
        }
        if (defaults.includes("--model")) expect(prepared.args.slice(0, 2)).toEqual(defaults);
      } finally {
        prepared.dispose();
      }
    }
  },
);
