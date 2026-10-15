import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import v1Fixture from "../../../fixtures/agent-plugin.json";
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
  expect(Object.isFrozen(provider.model?.hooks?.channels)).toBe(true);
  const tampered = { ...data, executables: ["unexpected"] };
  expect(() => bundledProvider(tampered, "claude", digest(data))).toThrow("integrity");
  expect(() => bundledProvider(data, "another", digest(data))).toThrow("identity");
  expect(() => bundledProvider(v1Fixture, v1Fixture.id, digest(v1Fixture))).toThrow("identity");
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
  const original = await provider.prepareLaunch?.(
    installation,
    request,
    ["--model", "test"],
    undefined,
    false,
    true,
    binding(),
  );
  const duplicate = await copy.prepareLaunch?.(
    copyInstallation,
    { ...request, agent: copy.id },
    ["--model", "test"],
    undefined,
    false,
    true,
    binding(),
  );
  try {
    expect(duplicate?.args).toEqual(original?.args);
  } finally {
    original?.dispose();
    duplicate?.dispose();
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
    const prepared = await provider.prepareLaunch?.(
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
    if (!prepared) throw new Error("Missing engine");
    const file = prepared.args[prepared.args.indexOf("--mcp-config") + 1] ?? "";
    try {
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
        ...["open_preview", "list_previews", "close_preview"].map(
          (tool) => `mcp__${name}__${tool}`,
        ),
        ...(hooks ? ["--settings", settings] : []),
        "--",
        "Task from your Foom orchestrator (another agent, not the user):\n\nFix it",
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
