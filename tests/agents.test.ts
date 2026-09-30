import { ChildProcess, execFile } from "node:child_process";
import { statSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService, loginPath } from "../src/agents";
import type { TerminalSpec } from "../src/shared/desktop";
import type { AgentHooks, AgentLaunch } from "../src/shared/agents";

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
  service = new AgentService({ listWorktrees }, { create }, prepare);
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
    expect(prepare).not.toHaveBeenCalled();
    await service.launch({ ...request, agent: "codex", acknowledgeCodexNotifierReplacement: true });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["-c", `notify=${JSON.stringify(binding.codexCommand)}`] }),
    );
    service.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
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
    service = new AgentService({ listWorktrees }, { create });
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
    service = new AgentService({ listWorktrees }, { create: asyncCreate }, prepare);
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
