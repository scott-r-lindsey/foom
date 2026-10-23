import {
  binding,
  cleanup,
  create,
  launchIdentity,
  listWorktrees,
  prepare,
  request,
  root,
  agentFixture,
  tree,
  versions,
} from "./agents-fixture";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AgentService } from "../../../../src/main/agents/agents";
import { PluginSetup } from "../../../../src/main/agents/plugin-setup";
import { prepareMcpLaunch } from "../../../../src/main/agents/providers/mcp-launch";

describe("conversation resume", () => {
  it.each(["claude", "codex", "agy"] as const)(
    "resumes %s with fresh per-launch hooks and the same terminal ID",
    async (agent) => {
      const status = vi
        .spyOn(PluginSetup.prototype, "status")
        .mockResolvedValue({ state: "installed", actions: [] });
      await agentFixture.service.launch({
        ...request,
        agent,
        terminalId: "original",
        conversationId: "conversation-123",
      });
      const spec = create.mock.calls[0]?.[0];
      expect(spec?.id).toBe("original");
      expect(spec?.args.slice(0, 2)).toEqual([
        agent === "claude" ? "--resume" : agent === "codex" ? "resume" : "--conversation",
        "conversation-123",
      ]);
      if (agent !== "agy") expect(spec?.args).toContain(agent === "claude" ? "--settings" : "-c");
      expect(spec?.env).toMatchObject(binding.env);
      expect(prepare).toHaveBeenCalledWith(agent);
      status.mockRestore();
    },
  );
  it.each(["claude", "codex", "agy"] as const)(
    "rejects malformed %s IDs before preparing hooks or creating a PTY",
    async (agent) => {
      await expect(
        agentFixture.service.launch({ ...request, agent, conversationId: "--last" }),
      ).rejects.toThrow("Invalid conversation ID");
      expect(prepare).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );
});

it.each([true, false])(
  "provisions control independently of hooks=%s and revokes on exit",
  async (hooks) => {
    const bindControl = vi.fn();
    const disposeControl = vi.fn();
    const control = vi.fn(() =>
      Promise.resolve({
        env: { FOOM_CONTROL_TOKEN: "control-secret", FOOM_SESSION: "control-session" },
        bind: bindControl,
        dispose: disposeControl,
      }),
    );
    agentFixture.service = new AgentService(
      { listWorktrees, launchIdentity },
      { create },
      prepare,
      control,
    );
    agentFixture.service.setHooksEnabled(hooks);
    await agentFixture.service.launch(request);
    expect(control).toHaveBeenCalledWith(root, tree, hooks ? "session" : undefined, undefined);
    expect(create.mock.calls.at(-1)?.[0].env).toMatchObject({
      FOOM_CONTROL_TOKEN: "control-secret",
      FOOM_SESSION: hooks ? "session" : "control-session",
    });
    expect(bindControl).toHaveBeenCalledWith("terminal-id", false);
    agentFixture.service.release("terminal-id");
    expect(disposeControl).toHaveBeenCalledTimes(1);
  },
);

it.each(["spawn", "shutdown", "early-exit"])(
  "revokes control on launch lifecycle race %s",
  async (mode) => {
    const disposeControl = vi.fn();
    const bindControl = vi.fn();
    const control = () => Promise.resolve({ env: {}, bind: bindControl, dispose: disposeControl });
    const spawn = vi.fn(() => {
      if (mode === "spawn") throw new Error("spawn failed");
      if (mode === "shutdown") agentFixture.service.dispose();
      if (mode === "early-exit") agentFixture.service.release("early");
      return "early";
    });
    agentFixture.service = new AgentService(
      { listWorktrees, launchIdentity },
      { create: spawn },
      prepare,
      control,
    );
    if (mode === "early-exit") {
      await expect(agentFixture.service.launch(request)).resolves.toHaveProperty("id", "early");
      expect(disposeControl).toHaveBeenCalledTimes(1);
      await expect(agentFixture.service.launch(request)).resolves.toHaveProperty("id", "early");
    } else await expect(agentFixture.service.launch(request)).rejects.toThrow();
    expect(disposeControl).toHaveBeenCalled();
    expect(bindControl).not.toHaveBeenCalled();
  },
);

it("revokes prepared hooks if control setup fails", async () => {
  agentFixture.service = new AgentService(
    { listWorktrees, launchIdentity },
    { create },
    prepare,
    () => Promise.reject(new Error("control failed")),
  );
  await expect(agentFixture.service.launch(request)).rejects.toThrow("control failed");
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it("rotates control credentials when resuming the same terminal", async () => {
  const first = { env: { FOOM_CONTROL_TOKEN: "first" }, bind: vi.fn(), dispose: vi.fn() };
  const second = { env: { FOOM_CONTROL_TOKEN: "second" }, bind: vi.fn(), dispose: vi.fn() };
  const control = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  agentFixture.service = new AgentService(
    { listWorktrees, launchIdentity },
    { create },
    prepare,
    control,
  );
  await agentFixture.service.launch(request);
  agentFixture.service.release("terminal-id");
  expect(first.dispose).toHaveBeenCalledOnce();
  await agentFixture.service.launch({
    ...request,
    terminalId: "terminal-id",
    conversationId: "saved-id",
  });
  expect(create.mock.calls.at(-1)?.[0]).toMatchObject({
    id: "terminal-id",
    env: { FOOM_CONTROL_TOKEN: "second" },
  });
  expect(second.bind).toHaveBeenCalledWith("terminal-id", false);
  expect(second.dispose).not.toHaveBeenCalled();
  agentFixture.service.release("terminal-id");
  expect(second.dispose).toHaveBeenCalledOnce();
  expect(first.dispose).toHaveBeenCalledOnce();
});

it.each([true, false])(
  "attaches MCP independently of hooks=%s and disposes on exit",
  async (hooks) => {
    const previous = versions.claude;
    versions.claude = "2.1.296 (Claude Code)";
    agentFixture.help += "\n--mcp-config <file>";
    const dispose = vi.fn();
    const bind = vi.fn();
    vi.mocked(prepareMcpLaunch).mockResolvedValue({
      args: ["--mcp-config", "/private/mcp.json"],
      dispose,
    });
    agentFixture.service = new AgentService(
      { listWorktrees, launchIdentity },
      { create },
      prepare,
      () =>
        Promise.resolve({
          env: { FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1" },
          bind,
          dispose: vi.fn(),
        }),
    );
    agentFixture.service.setHooksEnabled(hooks);
    try {
      expect((await agentFixture.service.scan()).agents[0]?.mcp).toBe(true);
      await agentFixture.service.launch(request);
      expect(bind).toHaveBeenCalledWith("terminal-id", true);
      expect(create.mock.calls.at(-1)?.[0].args).toContain("--mcp-config");
      agentFixture.service.release("terminal-id");
      await expect
        .poll(async () => {
          try {
            await readFile(create.mock.calls.at(-1)?.[0].args[1] ?? "");
            return false;
          } catch {
            return true;
          }
        })
        .toBe(true);
    } finally {
      versions.claude = previous;
    }
  },
);

it("restores an orchestrator's role without a launch prompt and appends a child's prompt after every option", async () => {
  const controlFor = vi.fn((..._args: unknown[]) =>
    Promise.resolve({
      env: { FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1" },
      bind: vi.fn(),
      dispose: vi.fn(),
    }),
  );
  agentFixture.service = new AgentService(
    { listWorktrees, launchIdentity },
    { create },
    prepare,
    controlFor,
  );
  await expect(
    agentFixture.service.launch({ ...request, control: { role: "orchestrator" } }),
  ).rejects.toThrow("without MCP");
  agentFixture.service.release("terminal-id");
  const previous = versions.claude;
  versions.claude = "2.1.293 (Claude Code)";
  agentFixture.help += "\n--mcp-config <file>";
  vi.mocked(prepareMcpLaunch).mockResolvedValue({
    args: ["--mcp-config", "/private/mcp.json"],
    dispose: vi.fn(),
  });
  try {
    await agentFixture.service.scan();
    await agentFixture.service.launch({ ...request, control: { role: "orchestrator" } });
    expect(controlFor).toHaveBeenLastCalledWith(root, tree, expect.anything(), {
      role: "orchestrator",
    });
    agentFixture.service.release("terminal-id");
    await agentFixture.service.launch({
      ...request,
      control: { parentId: "parent" },
      prompt: "Write tests",
    });
    expect(controlFor).toHaveBeenLastCalledWith(root, tree, expect.anything(), {
      parentId: "parent",
    });
    expect(create.mock.calls.at(-1)?.[0].args.at(-1)).toMatch(
      /^Task from your Foom orchestrator[^]*\n\nWrite tests$/u,
    );
  } finally {
    versions.claude = previous;
  }
});

it.each([
  { agent: "claude", hooks: false },
  { agent: "claude", hooks: true },
  { agent: "codex", hooks: false },
  { agent: "codex", hooks: true },
] as const)("delimits $agent child prompts with hooks=$hooks", async ({ agent, hooks }) => {
  const previous = versions[agent];
  versions[agent] = agent === "claude" ? "2.1.293 (Claude Code)" : "codex-cli 0.161.0";
  agentFixture.help += "\n--mcp-config <configs...>\n--no-alt-screen";
  const mcpArgs =
    agent === "claude" ? ["--mcp-config", "/private/mcp.json"] : ["-c", "mcp_servers.foom={}"];
  vi.mocked(prepareMcpLaunch).mockResolvedValue({ args: mcpArgs, dispose: vi.fn() });
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
  agentFixture.service.setHooksEnabled(hooks);
  try {
    for (const prompt of [undefined, "Write tests\nKeep $(command) literal"]) {
      await agentFixture.service.launch({
        ...request,
        agent,
        control: { parentId: "parent" },
        ...(prompt === undefined ? {} : { prompt }),
      });
      const args = create.mock.calls.at(-1)?.[0].args;
      expect(args).toEqual(
        expect.arrayContaining(
          agent === "claude"
            ? ["--mcp-config"]
            : ["-c", expect.stringMatching(/^mcp_servers\.foom_[a-f0-9]+=/u)],
        ),
      );
      if (prompt === undefined) expect(args).not.toContain("--");
      else
        expect(args?.slice(-2)).toEqual([
          "--",
          `Task from your Foom orchestrator (another agent, not the user):\nBefore stopping when finished, blocked, or CI fails, report to your parent with handoff({ status: done|blocked|failed, summary, links?, idempotencyKey }), or foom handoff --status done|blocked|failed --summary-file FILE|- [--link HTTPS_URL] --idempotency-key KEY. Handoffs are pull-only; they never type into a terminal.\n\n${prompt}`,
        ]);
      expect(prepare).toHaveBeenCalledTimes(hooks ? (prompt === undefined ? 1 : 2) : 0);
      agentFixture.service.release("terminal-id");
    }
  } finally {
    versions[agent] = previous;
  }
});

it.each(["denied", "spawn", "early-exit"])("cleans MCP launch on %s", async (mode) => {
  const previous = versions.claude;
  versions.claude = "2.1.293 (Claude Code)";
  agentFixture.help += "\n--mcp-config <file>";
  const revoke = vi.fn();
  const spawn = () => {
    if (mode === "spawn") throw new Error("spawn");
    agentFixture.service.release("early");
    return "early";
  };
  agentFixture.service = new AgentService(
    { listWorktrees, launchIdentity },
    { create: spawn },
    prepare,
    () =>
      Promise.resolve({
        env: {
          FOOM_CONTROL_URL: mode === "denied" ? "invalid" : "http://127.0.0.1:1234/control/v1",
        },
        bind: vi.fn(),
        dispose: revoke,
      }),
  );
  try {
    if (mode === "early-exit") await agentFixture.service.launch(request);
    else
      await expect(agentFixture.service.launch(request)).rejects.toThrow(
        mode === "denied" ? "Invalid URL" : mode,
      );
    expect(revoke).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
  } finally {
    versions.claude = previous;
  }
});
