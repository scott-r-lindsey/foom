import { ChildProcess, execFile } from "node:child_process";
import { statSync } from "node:fs";
import type * as Fs from "node:fs/promises";
import { access, stat } from "node:fs/promises";
import type * as Os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { AgentService } from "../../../../src/main/agents/agents";
import { replaceConfigProviders } from "../../../../src/main/agents/providers/registry";
import type { AgentHooks, AgentLaunch } from "../../../../src/shared/agents";
import type { TerminalSpec } from "../../../../src/shared/desktop";
vi.mock("../../../../src/main/login-shell", async () => {
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  return { readLoginShell: promisify(execFile) };
});
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

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof Fs>()),
  access: vi.fn(),
  stat: vi.fn(),
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof Os>()),
  homedir: vi.fn(() => "/home/test"),
  userInfo: vi.fn(() => ({ shell: "/bin/zsh" })),
}));
export const root = process.platform === "win32" ? "C:\\agents" : "/agents";
export const tree = join(root, "worktree");
export const versions: Record<string, string> & { claude: string; codex: string; agy: string } = {
  claude: "2.1.284 (Claude Code)",
  codex: "codex-cli 0.155.1",
  agy: "agy 1.1.13",
  copilot: "GitHub Copilot CLI 1.0.103.",
  pi: "1.4.0",
};
export const listWorktrees = vi.fn();
export const launchIdentity = vi.fn(() => Promise.resolve("identity"));
export const create = vi.fn((_spec: TerminalSpec) => "terminal-id");
export const cleanup = vi.fn();
export const binding: AgentHooks = {
  v2: {
    values: {
      "observerCommand:lifecycle": "/foom adapter --stdin",
      "observerArgv:lifecycle": ["/foom adapter", "--argv"],
      "observerArgv:notify": ["/foom adapter", "--argv"],
    },
    channels: new Map(),
    state: {},
  },
  observerCommand: "/foom adapter --stdin",
  observerArgv: ["/foom adapter", "--argv"],
  env: { FOOM_SESSION: "session", FOOM_TOKEN: "secret" },
  dispose: cleanup,
};
export const prepare = vi.fn(() => Promise.resolve(binding));
export const request: AgentLaunch = {
  agent: "claude",
  repository: root,
  worktree: tree,
  cols: 80,
  rows: 24,
};

export const agentFixture = {
  help: "",
  failed: "",
  service: new AgentService({ listWorktrees, launchIdentity }, { create }, prepare),
};

beforeEach(() => {
  vi.clearAllMocks();
  binding.v2?.channels.clear();
  create.mockReset().mockImplementation(() => "terminal-id");
  launchIdentity.mockReset().mockResolvedValue("identity");
  vi.stubEnv("PATH", root);
  agentFixture.help = "--settings <file-or-json>\n-c, --config <key=value>";
  agentFixture.failed = "";
  vi.mocked(access).mockResolvedValue();
  vi.mocked(stat).mockResolvedValue(
    Object.assign(statSync(process.execPath, { bigint: true }), { isFile: () => true }),
  );
  vi.mocked(execFile).mockImplementation((file, args, _options, callback) => {
    if (typeof callback !== "function" || !Array.isArray(args))
      throw new Error("Expected argument array");
    let output: string;
    if (file === "/bin/zsh") output = `startup chatter\0FOOM_PATH\0${root}\0goodbye`;
    else if (args[0] === "--help") output = agentFixture.help;
    else
      output =
        versions[
          file
            .split(/[\\/]/u)
            .at(-1)
            ?.replace(/\.exe$/u, "") ?? ""
        ] ?? "";
    callback(agentFixture.failed === args[0] ? new Error("probe failed") : null, output, "");
    return new ChildProcess();
  });
  listWorktrees.mockResolvedValue([{ path: tree, managed: true, bare: false, prunable: false }]);
  agentFixture.service = new AgentService({ listWorktrees, launchIdentity }, { create }, prepare);
});
afterEach(() => {
  vi.unstubAllEnvs();
  replaceConfigProviders([]);
});
