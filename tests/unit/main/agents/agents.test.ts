import { AgyPlugin } from "../../../../src/main/agents/agy-plugin";
import { ChildProcess, execFile } from "node:child_process";
import { statSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as McpLaunch from "../../../../src/main/agents/mcp-launch";
import { prepareMcpLaunch } from "../../../../src/main/agents/mcp-launch";
import { AgentService, loginPath } from "../../../../src/main/agents/agents";
import type { TerminalSpec } from "../../../../src/shared/desktop";
import type { AgentHooks, AgentLaunch } from "../../../../src/shared/agents";

vi.mock("node:child_process", async (original) => {
  const actual = await original<{ execFile: typeof execFile; ChildProcess: typeof ChildProcess }>();
  const mocked = vi.fn();
  Object.defineProperty(mocked, Symbol.for("nodejs.util.promisify.custom"), {
    value: (file: string, args: string[], options: unknown) =>
      new Promise((resolve, reject) => {
        mocked(file, args, options, (error: Error | null, stdout: string, stderr: string) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      }),
  });
  return { ...actual, execFile: mocked };
});
vi.mock("../../../../src/main/agents/mcp-launch", async (original) => ({
  ...(await original<typeof McpLaunch>()),
  prepareMcpLaunch: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ access: vi.fn(), stat: vi.fn() }));
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/test"),
  userInfo: vi.fn(() => ({ shell: "/bin/zsh" })),
}));
const root = process.platform === "win32" ? "C:\\agents" : "/agents";
const tree = join(root, "worktree");
const versions: Record<string, string> & { claude: string; codex: string; agy: string } = {
  claude: "2.1.284 (Claude Code)",
  codex: "codex-cli 0.155.1",
  agy: "agy 1.1.13",
};
let help: string;
let failed: string;
const listWorktrees = vi.fn();
const launchIdentity = vi.fn(() => Promise.resolve("identity"));
const create = vi.fn((_spec: TerminalSpec) => "terminal-id");
const cleanup = vi.fn();
const binding: AgentHooks = {
  claudeCommand: "/foom adapter --stdin",
  codexCommand: ["/foom adapter", "--argv"],
  env: { FOOM_SESSION: "session", FOOM_TOKEN: "secret" },
  dispose: cleanup,
};
const prepare = vi.fn(() => Promise.resolve(binding));
let service: AgentService;
const request: AgentLaunch = {
  agent: "claude",
  repository: root,
  worktree: tree,
  cols: 80,
  rows: 24,
};

beforeEach(() => {
  vi.clearAllMocks();
  launchIdentity.mockReset().mockResolvedValue("identity");
  vi.stubEnv("PATH", root);
  help = "--settings <file-or-json>\n-c, --config <key=value>";
  failed = "";
  vi.mocked(access).mockResolvedValue();
  vi.mocked(stat).mockResolvedValue(
    Object.assign(statSync(process.execPath, { bigint: true }), { isFile: () => true }),
  );
  vi.mocked(execFile).mockImplementation((file, args, _options, callback) => {
    if (typeof callback !== "function" || !Array.isArray(args))
      throw new Error("Expected argument array");
    let output: string;
    if (file === "/bin/zsh") output = `startup chatter\0FOOM_PATH\0${root}\0goodbye`;
    else if (args[0] === "--help") output = help;
    else
      output =
        versions[
          file
            .split(/[\\/]/u)
            .at(-1)
            ?.replace(/\.exe$/u, "") ?? ""
        ] ?? "";
    callback(failed === args[0] ? new Error("probe failed") : null, output, "");
    return new ChildProcess();
  });
  listWorktrees.mockResolvedValue([{ path: tree, managed: true, bare: false, prunable: false }]);
  service = new AgentService({ listWorktrees, launchIdentity }, { create }, prepare);
});
afterEach(() => vi.unstubAllEnvs());

describe("detection", () => {
  it("preserves full versions and probes help before advertising hooks", async () => {
    const scan = await service.scan();
    expect(scan.path).toBe(root);
    expect(scan.agents.map((agent) => [agent.id, agent.version, agent.hooks])).toEqual([
      ["claude", versions.claude, true],
      ["codex", versions.codex, true],
      ["agy", versions.agy, false],
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
      const scan = await service.scan();
      expect(scan.agents.slice(0, 2).map((agent) => agent.hooks)).toEqual([hooks, hooks]);
      expect(scan.agents[0]?.version).toBe(claude);
      await expect(service.launch(request)).resolves.toHaveProperty(
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
      help = text;
      expect((await service.scan()).agents.every((agent) => !agent.hooks)).toBe(true);
    },
  );
  it("reports missing executables and rescans without retaining stale results", async () => {
    vi.mocked(access).mockRejectedValue(new Error("missing"));
    expect((await service.scan()).agents.every((agent) => agent.path === null)).toBe(true);
    await expect(service.launch(request)).rejects.toThrow("not installed");
    vi.mocked(access).mockResolvedValue();
    expect((await service.scan()).agents.every((agent) => agent.path !== null)).toBe(true);
    await expect(service.launch(request)).resolves.toEqual({
      id: "terminal-id",
      attention: "hooks",
    });
  });
  it("does not treat directories as executables", async () => {
    vi.mocked(stat).mockResolvedValue(
      Object.assign(statSync(process.execPath, { bigint: true }), { isFile: () => false }),
    );
    expect((await service.scan()).agents.every((agent) => agent.path === null)).toBe(true);
  });
  it("falls back for failed probes, empty versions, and unsupported help", async () => {
    failed = "--help";
    expect((await service.scan()).agents.every((agent) => !agent.hooks && agent.version)).toBe(
      true,
    );
    failed = "--version";
    expect(
      (await service.scan()).agents.every((agent) => !agent.hooks && agent.version === null),
    ).toBe(true);
    failed = "";
    const previous = versions.claude;
    versions.claude = "";
    help = "--other";
    expect((await service.scan()).agents.every((agent) => !agent.hooks)).toBe(true);
    versions.claude = previous;
  });
  it("keeps unknown versions on evaluator fallback", async () => {
    const previous = versions.codex;
    versions.codex = "codex-cli unknown";
    expect((await service.scan()).agents[1]?.hooks).toBe(false);
    versions.codex = previous;
    await service.launch({ ...request, agent: "codex" });
    expect(prepare).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === "win32")(
    "recovers from login-shell failure and ignores relative PATH entries",
    async () => {
      failed = "-ilc";
      vi.stubEnv("PATH", ":relative:");
      expect(await loginPath()).toEqual({
        path: ":relative:",
        warning: "Login shell PATH unavailable; using the inherited PATH.",
      });
      expect((await service.scan()).agents.every((agent) => agent.path === null)).toBe(true);
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

describe("launch", () => {
  it("launches Claude through the manager with invocation-only settings and resolved PATH", async () => {
    await service.launch(request);
    const spec = create.mock.calls[0];
    expect(spec).toEqual([
      expect.objectContaining({
        cwd: tree,
        cols: 80,
        rows: 24,
        env: { ...binding.env, PATH: root },
        args: [
          "--settings",
          JSON.stringify({
            hooks: {
              UserPromptSubmit: [{ hooks: [{ type: "command", command: binding.claudeCommand }] }],
              PreToolUse: [{ hooks: [{ type: "command", command: binding.claudeCommand }] }],
              Stop: [{ hooks: [{ type: "command", command: binding.claudeCommand }] }],
              PermissionRequest: [{ hooks: [{ type: "command", command: binding.claudeCommand }] }],
              Notification: [{ hooks: [{ type: "command", command: binding.claudeCommand }] }],
            },
          }),
        ],
      }),
    ]);
    service.release("terminal-id");
    service.release("terminal-id");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it("tells the hook binding its terminal ID once the launch has one", async () => {
    const bind = vi.fn();
    prepare.mockResolvedValueOnce({ ...binding, bind });
    await service.launch(request);
    expect(bind).toHaveBeenCalledExactlyOnceWith("terminal-id");
  });
  it("requires disclosure before replacing a Codex notifier", async () => {
    await expect(service.launch({ ...request, agent: "codex" })).rejects.toThrow(
      "replaces your Codex notifier",
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    await service.launch({ ...request, agent: "codex", acknowledgeCodexNotifierReplacement: true });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["-c", `notify=${JSON.stringify(binding.codexCommand)}`] }),
    );
    service.dispose();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
  it("disables all attachment with the setting and never hooks Antigravity", async () => {
    service.setHooksEnabled(false);
    await service.launch({ ...request, agent: "codex" });
    service.release("terminal-id");
    service.setHooksEnabled(true);
    await service.launch({ ...request, agent: "agy" });
    expect(prepare).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ args: [], env: { PATH: root } }));
  });
  it("uses evaluation when a hook receiver is unavailable", async () => {
    service = new AgentService({ listWorktrees, launchIdentity }, { create });
    await expect(service.launch(request)).resolves.toEqual({
      id: "terminal-id",
      attention: "evaluator",
    });
  });
  it("revokes hooks if PTY creation fails", async () => {
    create.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });
    await expect(service.launch(request)).rejects.toThrow("spawn failed");
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it("awaits asynchronous terminal creation and cleans up rejected or cancelled launches", async () => {
    const asyncCreate = vi.fn<(_spec: TerminalSpec) => Promise<string>>();
    service = new AgentService({ listWorktrees, launchIdentity }, { create: asyncCreate }, prepare);
    asyncCreate.mockRejectedValueOnce(new Error("host stopped"));
    await expect(service.launch(request)).rejects.toThrow("host stopped");
    expect(cleanup).toHaveBeenCalledOnce();
    asyncCreate.mockResolvedValueOnce("host-terminal");
    await expect(service.launch(request)).resolves.toHaveProperty("id", "host-terminal");
    service.release("host-terminal");
    expect(cleanup).toHaveBeenCalledTimes(2);
    asyncCreate.mockImplementationOnce(() => {
      service.dispose();
      return Promise.resolve("late-terminal");
    });
    await expect(service.launch(request)).rejects.toThrow("disposed");
    expect(cleanup).toHaveBeenCalledTimes(3);
  });
  it("does not spawn if hook preparation fails", async () => {
    prepare.mockRejectedValueOnce(new Error("receiver failed"));
    await expect(service.launch(request)).rejects.toThrow("receiver failed");
    expect(create).not.toHaveBeenCalled();
  });
  it("reserves worktrees during concurrent launches and frees them on exit", async () => {
    const first = service.launch(request);
    await expect(service.launch(request)).rejects.toThrow("already running");
    await first;
    service.release("terminal-id");
    await expect(service.launch(request)).resolves.toHaveProperty("id", "terminal-id");
  });
  it("uses inherited PATH on Windows and discovers native executables", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const scan = await service.scan();
    expect(scan.warning).toBeNull();
    expect(scan.agents[0]?.path).toBe(join(root, "claude.exe"));
    expect(execFile).not.toHaveBeenCalledWith(
      "/bin/zsh",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
  it("cancels in-flight launches and revokes prepared hooks on shutdown", async () => {
    prepare.mockImplementationOnce(() => {
      service.dispose();
      return Promise.resolve(binding);
    });
    await expect(service.launch(request)).rejects.toThrow("disposed");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    await expect(service.launch(request)).rejects.toThrow("disposed");
  });
  it("rejects invalid dimensions, unknown agents, and unowned paths", async () => {
    for (const cols of [0, 501, 1.5, Number.NaN])
      await expect(service.launch({ ...request, cols })).rejects.toThrow("dimensions");
    const invalid = { ...request };
    Reflect.set(invalid, "agent", "unknown");
    await expect(service.launch(invalid)).rejects.toThrow("Unknown agent");
    for (const worktree of ["relative", `${tree}\0`])
      await expect(service.launch({ ...request, worktree })).rejects.toThrow("Invalid worktree");
    for (const entries of [
      [],
      [{ path: tree, managed: false }],
      [{ path: tree, managed: true, bare: true }],
      [{ path: tree, managed: true, prunable: true }],
    ]) {
      listWorktrees.mockResolvedValueOnce(entries);
      await expect(service.launch(request)).rejects.toThrow("not managed");
    }
    expect(create).not.toHaveBeenCalled();
  });
});

it.each([
  "--no-alt-screen",
  "  --no-alt-screen\n",
  "--no-alt-screen-extra",
  "prefix--no-alt-screen",
  "--other",
])("Codex inline launch requires the complete help flag: %s", async (text) => {
  help = text;
  service.setHooksEnabled(false);
  await service.launch({ ...request, agent: "codex" });
  expect(create.mock.calls[0]?.[0].args).toEqual(
    text.trim() === "--no-alt-screen" ? ["--no-alt-screen"] : [],
  );
});

it("main-only checkout authorization permits the registered checkout and retains shared occupancy after release or failure", async () => {
  listWorktrees.mockResolvedValue([{ path: root, managed: false, bare: false, prunable: false }]);
  const main = { ...request, worktree: root, mainCheckout: true, sharedCheckout: true };
  create.mockReturnValueOnce("first").mockReturnValueOnce("second");
  await service.launch(main);
  await service.launch(main);
  service.release("first");
  await expect(service.launch({ ...main, sharedCheckout: false })).rejects.toThrow(
    "already running",
  );
  create.mockImplementationOnce(() => {
    throw Error("spawn");
  });
  await expect(service.launch(main)).rejects.toThrow("spawn");
  await expect(service.launch({ ...main, sharedCheckout: false })).rejects.toThrow(
    "already running",
  );
  service.release("second");
  await service.launch({ ...main, sharedCheckout: false });
  service.release("terminal-id");
  await expect(service.launch({ ...main, mainCheckout: false })).rejects.toThrow("not managed");
});

it("launches a main-authorized external checkout at its selected directory", async () => {
  listWorktrees.mockResolvedValue([{ path: tree, managed: false, bare: false, prunable: false }]);
  await service.launch({ ...request, checkoutIdentity: "identity" });
  expect(launchIdentity).toHaveBeenCalledWith(root, tree);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ cwd: tree }));
});

it.each(["replaced", "locked"])(
  "revalidates external checkout identity after hook preparation (%s)",
  async (reason) => {
    listWorktrees.mockResolvedValue([{ path: tree, managed: false, bare: false, prunable: false }]);
    if (reason === "replaced") launchIdentity.mockResolvedValueOnce("replacement");
    else launchIdentity.mockRejectedValueOnce(new Error("Worktree is locked"));
    await expect(service.launch({ ...request, checkoutIdentity: "identity" })).rejects.toThrow(
      reason === "replaced" ? "has changed" : "locked",
    );
    expect(create).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    await service.launch({ ...request, checkoutIdentity: "identity" });
    expect(create).toHaveBeenCalledOnce();
  },
);

it("prepends literal defaults to Foom's inline and hook flags", async () => {
  help += "\n--no-alt-screen";
  const defaults = ["--model", "model with spaces", "-c", "model_reasoning_effort=high"];
  await service.launch({
    ...request,
    agent: "codex",
    defaultArguments: defaults,
    acknowledgeCodexNotifierReplacement: true,
  });
  expect(create.mock.calls[0]?.[0].args).toEqual([
    ...defaults,
    "--no-alt-screen",
    "-c",
    `notify=${JSON.stringify(binding.codexCommand)}`,
  ]);
});

it("keeps empty defaults identical to existing launches and validates main-only arguments", async () => {
  await service.launch({ ...request, defaultArguments: [] });
  const original = create.mock.calls[0]?.[0].args;
  service.release("terminal-id");
  await service.launch(request);
  expect(create.mock.calls[1]?.[0].args).toEqual(original);
  service.release("terminal-id");
  await expect(service.launch({ ...request, defaultArguments: ["--settings={}"] })).rejects.toThrow(
    "reserved",
  );
  expect(create).toHaveBeenCalledTimes(2);
});

it("passes defaults unchanged without hooks", async () => {
  service.setHooksEnabled(false);
  const defaults = ["--mode", "plan", "literal ; $(nothing) with spaces"];
  await service.launch({ ...request, agent: "agy", defaultArguments: defaults });
  expect(create.mock.calls[0]?.[0].args).toEqual(defaults);
});

describe("conversation resume", () => {
  it.each(["claude", "codex"] as const)(
    "resumes %s with fresh per-launch hooks and the same terminal ID",
    async (agent) => {
      await service.launch({
        ...request,
        agent,
        terminalId: "original",
        conversationId: "conversation-123",
        acknowledgeCodexNotifierReplacement: true,
      });
      const spec = create.mock.calls[0]?.[0];
      expect(spec?.id).toBe("original");
      expect(spec?.args.slice(0, 2)).toEqual([
        agent === "claude" ? "--resume" : "resume",
        "conversation-123",
      ]);
      expect(spec?.args).toContain(agent === "claude" ? "--settings" : "-c");
      expect(prepare).toHaveBeenCalledWith(agent);
    },
  );
  it("rejects malformed IDs before preparing hooks or creating a PTY", async () => {
    await expect(service.launch({ ...request, conversationId: "--last" })).rejects.toThrow(
      "Invalid conversation ID",
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
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
    service = new AgentService({ listWorktrees, launchIdentity }, { create }, prepare, control);
    service.setHooksEnabled(hooks);
    await service.launch(request);
    expect(control).toHaveBeenCalledWith(root, tree, hooks ? "session" : undefined);
    expect(create.mock.calls.at(-1)?.[0].env).toMatchObject({
      FOOM_CONTROL_TOKEN: "control-secret",
      FOOM_SESSION: hooks ? "session" : "control-session",
    });
    expect(bindControl).toHaveBeenCalledWith("terminal-id");
    service.release("terminal-id");
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
      if (mode === "shutdown") service.dispose();
      if (mode === "early-exit") service.release("early");
      return "early";
    });
    service = new AgentService(
      { listWorktrees, launchIdentity },
      { create: spawn },
      prepare,
      control,
    );
    if (mode === "early-exit") {
      await expect(service.launch(request)).resolves.toHaveProperty("id", "early");
      expect(disposeControl).toHaveBeenCalledTimes(1);
      await expect(service.launch(request)).resolves.toHaveProperty("id", "early");
    } else await expect(service.launch(request)).rejects.toThrow();
    expect(disposeControl).toHaveBeenCalled();
    expect(bindControl).not.toHaveBeenCalled();
  },
);
it("revokes prepared hooks if control setup fails", async () => {
  service = new AgentService({ listWorktrees, launchIdentity }, { create }, prepare, () =>
    Promise.reject(new Error("control failed")),
  );
  await expect(service.launch(request)).rejects.toThrow("control failed");
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it("rotates control credentials when resuming the same terminal", async () => {
  const first = { env: { FOOM_CONTROL_TOKEN: "first" }, bind: vi.fn(), dispose: vi.fn() };
  const second = { env: { FOOM_CONTROL_TOKEN: "second" }, bind: vi.fn(), dispose: vi.fn() };
  const control = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  service = new AgentService({ listWorktrees, launchIdentity }, { create }, prepare, control);
  await service.launch(request);
  service.release("terminal-id");
  expect(first.dispose).toHaveBeenCalledOnce();
  await service.launch({ ...request, terminalId: "terminal-id", conversationId: "saved-id" });
  expect(create.mock.calls.at(-1)?.[0]).toMatchObject({
    id: "terminal-id",
    env: { FOOM_CONTROL_TOKEN: "second" },
  });
  expect(second.bind).toHaveBeenCalledWith("terminal-id");
  expect(second.dispose).not.toHaveBeenCalled();
  service.release("terminal-id");
  expect(second.dispose).toHaveBeenCalledOnce();
  expect(first.dispose).toHaveBeenCalledOnce();
});

it.each([true, false])(
  "attaches MCP independently of hooks=%s and disposes on exit",
  async (hooks) => {
    const previous = versions.claude;
    versions.claude = "2.1.293 (Claude Code)";
    help += "\n--mcp-config <file>";
    const dispose = vi.fn();
    vi.mocked(prepareMcpLaunch).mockResolvedValue({
      args: ["--mcp-config", "/private/mcp.json"],
      dispose,
    });
    service = new AgentService({ listWorktrees, launchIdentity }, { create }, prepare, () =>
      Promise.resolve({
        env: { FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1" },
        bind: vi.fn(),
        dispose: vi.fn(),
      }),
    );
    service.setHooksEnabled(hooks);
    try {
      expect((await service.scan()).agents[0]?.mcp).toBe(true);
      await service.launch(request);
      expect(create.mock.calls.at(-1)?.[0].args).toContain("--mcp-config");
      service.release("terminal-id");
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      versions.claude = previous;
    }
  },
);
it.each(["denied", "spawn", "early-exit"])("cleans MCP launch on %s", async (mode) => {
  const previous = versions.claude;
  versions.claude = "2.1.293 (Claude Code)";
  help += "\n--mcp-config <file>";
  const dispose = vi.fn();
  const revoke = vi.fn();
  if (mode === "denied") vi.mocked(prepareMcpLaunch).mockRejectedValueOnce(new Error("denied"));
  else vi.mocked(prepareMcpLaunch).mockResolvedValue({ args: [], dispose });
  const spawn = () => {
    if (mode === "spawn") throw new Error("spawn");
    service.release("early");
    return "early";
  };
  service = new AgentService({ listWorktrees, launchIdentity }, { create: spawn }, prepare, () =>
    Promise.resolve({ env: {}, bind: vi.fn(), dispose: revoke }),
  );
  try {
    if (mode === "early-exit") await service.launch(request);
    else await expect(service.launch(request)).rejects.toThrow(mode);
    expect(revoke).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
    if (mode !== "denied") expect(dispose).toHaveBeenCalled();
  } finally {
    versions.claude = previous;
  }
});

it.each([true, false])(
  "Codex lifecycle launch preserves the notifier when observed trust is %s",
  async (trusted) => {
    const old = versions.codex;
    versions.codex = "codex-cli 0.161.0";
    const disposeMcp = vi.fn();
    vi.mocked(prepareMcpLaunch).mockResolvedValueOnce({
      args: ["-c", 'mcp_servers.foom.url="http://127.0.0.1:1234/control/v1/mcp"'],
      dispose: disposeMcp,
    });
    service = new AgentService({ listWorktrees, launchIdentity }, { create }, prepare, () =>
      Promise.resolve({
        env: { FOOM_CONTROL_URL: "http://127.0.0.1:1234/control/v1" },
        bind: vi.fn(),
        dispose: vi.fn(),
      }),
    );
    prepare.mockResolvedValueOnce({
      ...binding,
      codexHookCommand: "sh '/stable/observer.sh' codex",
      codexNotify: !trusted,
    });
    try {
      await service.launch({
        ...request,
        agent: "codex",
        acknowledgeCodexNotifierReplacement: !trusted,
      });
      const args = create.mock.calls[0]?.[0].args ?? [];
      expect(args.filter((arg) => arg.startsWith("hooks."))).toHaveLength(6);
      expect(args).toContain('mcp_servers.foom.url="http://127.0.0.1:1234/control/v1/mcp"');
      service.release("terminal-id");
      expect(disposeMcp).toHaveBeenCalledOnce();
      expect(args.some((arg) => arg.startsWith("notify="))).toBe(!trusted);
      expect(args.join(" ")).not.toContain("--dangerously-bypass-hook-trust");
      expect(args.join(" ")).not.toContain("secret");
    } finally {
      versions.codex = old;
      service.dispose();
    }
  },
);

it("does not suppress the notifier when lifecycle hooks cannot be attached", async () => {
  prepare.mockResolvedValueOnce({ ...binding, codexNotify: false });
  await expect(service.launch({ ...request, agent: "codex" })).rejects.toThrow(
    "replaces your Codex notifier",
  );
});

it.each(["not-installed", "installed", "outdated", "disabled", "unavailable"] as const)(
  "Antigravity %s plugins gate launch credentials without adding agent arguments",
  async (state) => {
    const status = vi.spyOn(AgyPlugin.prototype, "status").mockResolvedValue({ state });
    try {
      const scan = await service.scan();
      expect(scan.agents.find((agent) => agent.id === "agy")?.agyPlugin).toEqual({ state });
      const active = state === "installed" || state === "outdated";
      const result = await service.launch({ ...request, agent: "agy" });
      expect(result.attention).toBe(active ? "hooks" : "evaluator");
      expect(create.mock.calls[0]?.[0].args).toEqual([]);
      expect(create.mock.calls[0]?.[0].env?.["FOOM_TOKEN"]).toBe(active ? "secret" : undefined);
      service.release(result.id);
      service.setHooksEnabled(false);
      await service.launch({ ...request, agent: "agy" });
      expect(create.mock.calls[1]?.[0].env?.["FOOM_TOKEN"]).toBeUndefined();
    } finally {
      service.dispose();
      status.mockRestore();
    }
  },
);

describe("read-only review", () => {
  it.each(["claude", "codex"] as const)(
    "pins %s review arguments independently of defaults and hooks",
    async (agent) => {
      help += "\n--permission-mode <mode> plan\n--sandbox <mode> read-only";
      const scan = await service.scan();
      expect(scan.agents.find((entry) => entry.id === agent)?.review).toBe(true);
      await service.launch({
        ...request,
        agent,
        readOnly: true,
        acknowledgeCodexNotifierReplacement: true,
        defaultArguments:
          agent === "claude"
            ? ["--permission-mode", "acceptEdits", "do edits"]
            : ["--sandbox", "workspace-write", "-c", 'sandbox_mode="danger-full-access"'],
      });
      const args = create.mock.calls[0]?.[0].args;
      expect(args?.slice(0, agent === "claude" ? 2 : 4)).toEqual(
        agent === "claude"
          ? ["--permission-mode", "plan"]
          : ["--sandbox", "read-only", "-c", 'approval_policy="never"'],
      );
      expect(args).not.toContain("acceptEdits");
      expect(args).not.toContain("workspace-write");
      expect(args).toContain(
        agent === "claude" ? "--settings" : `notify=${JSON.stringify(binding.codexCommand)}`,
      );
      expect(args?.at(-1)).toContain("Review the current worktree changes");
      service.release("terminal-id");
      service.setHooksEnabled(false);
      await service.launch({ ...request, agent, readOnly: true, conversationId: "saved-session" });
      expect(create.mock.lastCall?.[0].args).toEqual(
        agent === "claude"
          ? ["--resume", "saved-session", "--permission-mode", "plan"]
          : ["resume", "saved-session", "--sandbox", "read-only", "-c", 'approval_policy="never"'],
      );
    },
  );
  it.each(["claude", "codex", "agy"] as const)(
    "fails closed for unsupported %s review",
    async (agent) => {
      await expect(service.launch({ ...request, agent, readOnly: true })).rejects.toThrow(
        "Read-only review is unavailable",
      );
      expect(create).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    },
  );
  it.each([
    "--permission-mode-extra plan",
    "--sandbox-extra read-only -c",
    "--sandbox read-only",
    "--sandbox workspace-write -c",
  ])("does not accept incomplete help: %s", async (probe) => {
    help = probe;
    const scan = await service.scan();
    expect(scan.agents.every((agent) => !agent.review)).toBe(true);
  });
});
