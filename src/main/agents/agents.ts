import { AgyPlugin } from "./agy-plugin";
import { cliGuidance } from "./cli-launch";
import { prepareMcpLaunch, supportsMcp } from "./mcp-launch";
import { codexHookArguments } from "./codex-hooks";
import { resumeArguments } from "./conversation";
import type { ControlLaunch } from "../control/types";
import { parseAgentArguments } from "./default-arguments";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentHooks,
  AgentId,
  AgentInstallation,
  AgentLaunch,
  AgentScan,
} from "../../shared/agents";
import type { TerminalSpec } from "../../shared/desktop";
import type { WorktreeService } from "../workspace/worktrees";

const execute = promisify(execFile);
const ids: readonly AgentId[] = ["claude", "codex", "agy"];
const probeOptions = { encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024 } as const;

/** Fixed shell program only: no executable paths, arguments, or agent output interpolated. */
export async function loginPath(): Promise<{ path: string; warning: string | null }> {
  const inherited = process.env["PATH"] ?? "";
  if (process.platform === "win32") return { path: inherited, warning: null };
  try {
    const shell = userInfo().shell;
    if (!shell || !isAbsolute(shell)) throw new Error("No login shell");
    const { stdout } = await execute(
      shell,
      ["-ilc", 'printf "\\000FOOM_PATH\\000%s\\000" "$PATH"'],
      {
        ...probeOptions,
        cwd: homedir(),
      },
    );
    const path = stdout.split("\0FOOM_PATH\0")[1]?.split("\0")[0];
    if (!path) throw new Error("Empty login PATH");
    return { path, warning: null };
  } catch {
    return { path: inherited, warning: "Login shell PATH unavailable; using the inherited PATH." };
  }
}

async function findExecutable(id: AgentId, path: string): Promise<string | null> {
  const suffixes = process.platform === "win32" ? [".exe", ".com", ""] : [""];
  for (const directory of path.split(delimiter)) {
    // Never discover an executable in an implicit current/worktree directory.
    if (!isAbsolute(directory)) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, id + suffix);
      try {
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        // Keep looking past missing or non-executable PATH entries.
      }
    }
  }
  return null;
}

/** Accept stable numeric releases, retaining the full probe string for display. */
function meetsMinimum(version: string, pattern: RegExp, minimum: readonly number[]): boolean {
  const match = pattern.exec(version);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  for (const [index, floor] of minimum.entries()) {
    const part = parts[index];
    if (part === undefined) throw new Error("Incomplete version pattern");
    if (part !== floor) return part > floor;
  }
  return true;
}

async function detect(id: AgentId, path: string): Promise<AgentInstallation> {
  const executable = await findExecutable(id, path);
  if (!executable)
    return { id, path: null, version: null, hooks: false, reason: "Not found on PATH." };
  let version: string | null = null;
  try {
    const options = { ...probeOptions, cwd: homedir(), env: { ...process.env, PATH: path } };
    version = (await execute(executable, ["--version"], options)).stdout.trim();
    if (!version) throw new Error("Empty version");
    const help = (await execute(executable, ["--help"], options)).stdout;
    const hooks =
      (id === "claude" &&
        meetsMinimum(
          version,
          /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?: \(Claude Code\))?$/u,
          [2, 1, 284],
        ) &&
        /(?:^|\s)--settings(?:[ =,]|$)/mu.test(help)) ||
      (id === "codex" &&
        meetsMinimum(
          version,
          /^codex-cli (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
          [0, 155, 1],
        ) &&
        /(?:^|\s)-c(?:[ ,]|$)/mu.test(help));
    return {
      id,
      path: executable,
      version,
      hooks,
      cliGuidance: id === "agy" && /(?:^|\s)--prompt-interactive(?:[ =,]|$)/mu.test(help),
      mcp: supportsMcp(id, version, help),
      mcpReason: supportsMcp(id, version, help)
        ? "Per-launch MCP supported; managed policy may deny attachment."
        : "Unverified per-launch MCP support; attachment unavailable.",
      ...(id === "codex" &&
      meetsMinimum(version, /^codex-cli (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, [0, 161, 0])
        ? { codexLifecycle: true }
        : {}),
      inline: id === "codex" && /(?:^|\s)--no-alt-screen(?:[ =,]|$)/mu.test(help),
      reason: hooks
        ? "Per-launch hooks supported."
        : "Unverified hook support; using output evaluation.",
    };
  } catch {
    return {
      id,
      path: executable,
      version,
      hooks: false,
      reason: "Version/help probe failed; using output evaluation.",
    };
  }
}

/** Main-only service, like WorktreeService. No agent config files are written. */
export class AgentService {
  private scanResult: AgentScan | undefined;
  private hooksEnabled = true;
  private closed = false;
  private readonly occupied = new Set<string>();
  private readonly launched = new Map<string, string>();
  private readonly mcpBindings = new Map<string, { dispose(): void }>();
  private readonly controls = new Map<string, ControlLaunch>();
  private readonly earlyExits = new Set<string>();
  private starting = 0;
  private readonly bindings = new Map<string, AgentHooks>();

  constructor(
    private readonly worktrees: Pick<WorktreeService, "listWorktrees" | "launchIdentity">,
    private readonly terminals: { create(spec: TerminalSpec): string | Promise<string> },
    private readonly prepareHooks?: (agent: AgentId) => Promise<AgentHooks>,
    private readonly prepareControl?: (
      repository: string,
      worktree: string,
      sessionId?: string,
    ) => Promise<ControlLaunch>,
    private readonly agyPlugin = new AgyPlugin(),
  ) {}

  private ensureOpen(): void {
    if (this.closed) throw new Error("Agent service is disposed");
  }

  setHooksEnabled(enabled: boolean): void {
    this.hooksEnabled = enabled;
  }

  async scan(): Promise<AgentScan> {
    const resolved = await loginPath();
    const agents = await Promise.all(
      ids.map(async (id) => {
        const agent = await detect(id, resolved.path);
        if (id !== "agy" || !agent.path) return agent;
        const agyPlugin = await this.agyPlugin.status(agent.path);
        return {
          ...agent,
          agyPlugin,
          hooks: agyPlugin.state === "installed" || agyPlugin.state === "outdated",
          reason:
            agyPlugin.state === "installed" || agyPlugin.state === "outdated"
              ? "Opt-in Foom plugin installed."
              : "Plugin unavailable or disabled; using output evaluation.",
        };
      }),
    );
    const result = Object.freeze({
      ...resolved,
      agents: Object.freeze(agents.map((agent) => Object.freeze(agent))),
    });
    this.scanResult = result;
    return result;
  }

  async launch(request: AgentLaunch): Promise<{ id: string; attention: "hooks" | "evaluator" }> {
    this.ensureOpen();
    if (!ids.includes(request.agent)) throw new Error("Unknown agent");
    if (
      ![request.cols, request.rows].every(
        (value) => Number.isInteger(value) && value >= 2 && value <= 500,
      )
    )
      throw new Error("Invalid terminal dimensions");
    if (!isAbsolute(request.worktree) || request.worktree.includes("\0"))
      throw new Error("Invalid worktree path");
    if (this.occupied.has(request.worktree) && !request.sharedCheckout)
      throw new Error("An agent is already running in this worktree");
    this.occupied.add(request.worktree);
    this.starting++;
    try {
      return await this.start(request);
    } catch (error) {
      if (![...this.launched.values()].includes(request.worktree))
        this.occupied.delete(request.worktree);
      throw error;
    } finally {
      this.starting--;
      if (this.starting === 0) this.earlyExits.clear();
    }
  }

  private async start(
    request: AgentLaunch,
  ): Promise<{ id: string; attention: "hooks" | "evaluator" }> {
    const defaults = parseAgentArguments(request.agent, request.defaultArguments ?? []);
    const resume =
      request.conversationId === undefined
        ? []
        : resumeArguments(request.agent, request.conversationId);
    const config = request.configCli;
    if (config === undefined) {
      const trees = await this.worktrees.listWorktrees(request.repository);
      if (
        !trees.some(
          (tree) => tree.path === request.worktree && !tree.bare && !tree.prunable && !tree.locked,
        )
      )
        throw new Error("Worktree is missing, bare, locked, or prunable");
    }
    const checkoutIdentity =
      config === undefined
        ? (request.checkoutIdentity ??
          (await this.worktrees.launchIdentity(request.repository, request.worktree)))
        : undefined;
    const scan = this.scanResult ?? (await this.scan());
    const agent = scan.agents.find((entry) => entry.id === request.agent);
    if (!agent?.path)
      throw new Error(`${request.agent} is not installed. Rescan after installing it.`);
    const attach = this.hooksEnabled && agent.hooks && this.prepareHooks;
    const binding = attach ? await attach(agent.id) : undefined;
    const notify =
      !agent.codexLifecycle || !binding?.codexHookCommand || binding.codexNotify !== false;
    if (attach && agent.id === "codex" && notify && !request.acknowledgeCodexNotifierReplacement) {
      binding?.dispose();
      throw new Error(
        "Foom replaces your Codex notifier for this launch. Acknowledge this or disable hooks.",
      );
    }
    let control: ControlLaunch | undefined;
    let mcp: Awaited<ReturnType<typeof prepareMcpLaunch>> | undefined;
    try {
      // Config sessions get no repository-scoped control grant.
      control =
        config === undefined
          ? await this.prepareControl?.(
              request.repository,
              request.worktree,
              binding?.env["FOOM_SESSION"],
            )
          : undefined;
      if (control && agent.mcp)
        mcp = await prepareMcpLaunch(agent.id, control.env["FOOM_CONTROL_URL"] ?? "");
      this.ensureOpen();
      if (
        config === undefined &&
        (await this.worktrees.launchIdentity(request.repository, request.worktree)) !==
          checkoutIdentity
      )
        throw new Error("Worktree has changed. Select it and try again.");
      const args = [
        ...resume,
        ...(control && agent.cliGuidance ? cliGuidance(defaults) : defaults),
        ...(agent.inline ? ["--no-alt-screen"] : []),
        ...(mcp?.args ?? []),
      ];
      if (binding) {
        if (agent.id === "claude") {
          const hook = [{ hooks: [{ type: "command", command: binding.claudeCommand }] }];
          args.push(
            "--settings",
            JSON.stringify({
              hooks: {
                UserPromptSubmit: hook,
                PreToolUse: hook,
                Stop: hook,
                PermissionRequest: hook,
                Notification: hook,
              },
            }),
          );
        } else if (agent.id === "codex") {
          if (agent.codexLifecycle && binding.codexHookCommand)
            args.push(...codexHookArguments(binding.codexHookCommand));
          if (notify) args.push("-c", `notify=${JSON.stringify(binding.codexCommand)}`);
        }
      }
      const cli = config ?? control?.env["FOOM_CLI_DIRECTORY"];
      const id = await this.terminals.create({
        ...(request.terminalId === undefined ? {} : { id: request.terminalId }),
        command: agent.path,
        args,
        cwd: request.worktree,
        cols: request.cols,
        rows: request.rows,
        env: {
          ...control?.env,
          ...binding?.env,
          PATH: cli ? `${cli}${delimiter}${scan.path}` : scan.path,
        },
      });
      this.ensureOpen();
      if (this.earlyExits.has(id)) {
        if (![...this.launched.values()].includes(request.worktree))
          this.occupied.delete(request.worktree);
        mcp?.dispose();
        control?.dispose();
        binding?.dispose();
        return { id, attention: binding ? "hooks" : "evaluator" };
      }
      this.launched.set(id, request.worktree);
      if (mcp) this.mcpBindings.set(id, mcp);
      if (control) {
        control.bind(id);
        this.controls.set(id, control);
      }
      if (binding) {
        this.bindings.set(id, binding);
        binding.bind?.(id);
      }
      return { id, attention: binding ? "hooks" : "evaluator" };
    } catch (error) {
      mcp?.dispose();
      control?.dispose();
      binding?.dispose();
      throw error;
    }
  }

  /** Call on terminal exit/kill. Revokes this launch's receiver credentials. */
  release(id: string): void {
    const worktree = this.launched.get(id);
    if (!worktree && this.starting > 0) this.earlyExits.add(id);
    this.mcpBindings.get(id)?.dispose();
    this.mcpBindings.delete(id);
    this.controls.get(id)?.dispose();
    this.controls.delete(id);
    this.launched.delete(id);
    if (worktree && ![...this.launched.values()].includes(worktree)) this.occupied.delete(worktree);
    const binding = this.bindings.get(id);
    this.bindings.delete(id);
    binding?.dispose();
  }

  dispose(): void {
    this.closed = true;
    for (const id of this.launched.keys()) this.release(id);
  }
}
