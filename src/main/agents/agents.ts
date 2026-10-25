import { remoteAgentTarget } from "../terminals/remote-bootstrap";
import { launchRemoteChild, type RemoteHooks } from "./remote-launch";
import { agentCapabilities } from "../../shared/agent-capabilities";
import type { DialogContent } from "../../shared/confirmation";
import type { PreparedLaunch } from "./providers/provider";
import { matchesArguments, bypassEnvironment } from "../../shared/agent-launch-values";
import {
  agentProvider,
  agentProviders,
  knownAgentId,
  providerRevision,
} from "./providers/registry";
import { AgyPlugin } from "./agy-plugin";
import { ManualMcp } from "../control/manual-mcp";
import type { ControlLaunch } from "../control/types";
import { hasBypassArgument, parseAgentArguments } from "./default-arguments";
import { buildLaunchEnvironment, inheritedEnvironment } from "../setup/environment";
import { execFile } from "node:child_process";
import { readLoginShell } from "../login-shell";
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
  AgentLaunched,
  AgentScan,
} from "../../shared/agents";
import type { TerminalSpec } from "../../shared/desktop";
import type { WorktreeService } from "../workspace/worktrees";

const execute = promisify(execFile);
const probeOptions = { encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024 } as const;

/** Fixed shell program only: no executable paths, arguments, or agent output interpolated. */
export async function loginPath(): Promise<{ path: string; warning: string | null }> {
  const inherited = process.env["PATH"] ?? "";
  if (process.platform === "win32") return { path: inherited, warning: null };
  try {
    const shell = userInfo().shell;
    if (!shell || !isAbsolute(shell)) throw new Error("No login shell");
    const { stdout } = await readLoginShell(
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

async function findExecutable(id: string, path: string): Promise<string | null> {
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

async function detect(id: AgentId, path: string, probeEnabled = true): Promise<AgentInstallation> {
  const provider = agentProvider(id);
  await provider.validate?.();
  let executable: string | null = null;
  for (const name of provider.executableNames) {
    executable = await findExecutable(name, path);
    if (executable) break;
  }
  if (!executable)
    return { id, path: null, version: null, hooks: false, reason: "Not found on PATH." };
  if (!probeEnabled)
    return { id, path: executable, version: null, hooks: false, reason: "Turned off" };
  const options = { ...probeOptions, cwd: homedir(), env: { ...process.env, PATH: path } };
  const probe = async (flag: "--version" | "--help"): Promise<string> => {
    await provider.validate?.();
    if (agentProvider(id) !== provider) throw new Error("Agent plugins changed. Scan again.");
    try {
      return (await execute(executable, [flag], options)).stdout;
    } catch {
      return "";
    }
  };
  const version = (await probe("--version")).trim();
  const help = await probe("--help");
  await provider.validate?.();
  if (agentProvider(id) !== provider) throw new Error("Agent plugins changed. Scan again.");
  return provider.discover(executable, version, help);
}

/** Main-only service, like WorktreeService. No agent config files are written. */
export class AgentService {
  private scanResult: AgentScan | undefined;
  private scannedRevision = -1;
  private hooksEnabled = true;
  private agentHooks: Readonly<Record<string, boolean>> = {};
  private closed = false;
  private readonly occupied = new Set<string>();
  private readonly launched = new Map<string, string>();
  private readonly mcpBindings = new Map<string, { dispose(): void }>();
  private readonly manuals = new Map<string, ManualMcp>();
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
      control?: AgentLaunch["control"],
    ) => Promise<ControlLaunch>,
    private readonly agyPlugin = new AgyPlugin(),
    private readonly confirmLaunchBypass?: (content: DialogContent) => Promise<boolean>,
    private readonly remoteHooks?: RemoteHooks,
  ) {}

  private ensureOpen(): void {
    if (this.closed) throw new Error("Agent service is disposed");
  }

  setHooksEnabled(enabled: boolean, preferences: Readonly<Record<string, boolean>> = {}): void {
    this.hooksEnabled = enabled;
    this.agentHooks = preferences;
  }

  async scan(enabled: Readonly<Record<string, boolean>> = {}): Promise<AgentScan> {
    const resolved = await loginPath();
    const revision = providerRevision();
    const agents = await Promise.all(
      agentProviders().map(async (provider) =>
        (enabled[provider.id] === false
          ? detect(provider.id, resolved.path, false)
          : provider.enrich(await detect(provider.id, resolved.path), this.agyPlugin)
        ).then((agent) => ({
          ...agent,
          name: provider.name,
          mark: provider.mark,
          command: provider.executableNames[0] ?? provider.id,
          resume: Boolean(provider.model.launch.resume),
          attentionSignal: !agentCapabilities({
            model: provider.model,
          }).warnings.includes("No attention signal"),
          ...(provider.origin === "bundled" ? {} : { source: `agents/${provider.id}.json` }),
          resumePaste: provider.model.resumePaste,
          restoreControl: agent.restoreControl ?? provider.model.conversation.restoreControl,
        })),
      ),
    );
    if (revision !== providerRevision()) {
      this.scanResult = undefined;
      throw new Error("Agent plugins changed. Scan again.");
    }
    const result = Object.freeze({
      ...resolved,
      agents: Object.freeze(agents.map((agent) => Object.freeze(agent))),
    });
    this.scanResult = result;
    this.scannedRevision = revision;
    return result;
  }

  async launch(request: AgentLaunch): Promise<AgentLaunched> {
    this.ensureOpen();
    if (!knownAgentId(request.agent)) throw new Error("Unknown agent");
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

  private async start(request: AgentLaunch): Promise<AgentLaunched> {
    const provider = agentProvider(request.agent);
    await provider.validate?.();
    const defaults = parseAgentArguments(request.agent, request.defaultArguments ?? []);
    if (request.conversationId !== undefined) provider.resume(request.conversationId);
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
    const remote = remoteAgentTarget(process.argv, request.worktree);
    if (remote) {
      if (hasBypassArgument(request.agent, defaults))
        throw new Error("Unattended child bypass is unavailable");
      if (!request.control || !("parentId" in request.control))
        throw new Error("Remote phase 2 requires a local-orchestrator-owned child");
      const control = await this.prepareControl?.(
        request.repository,
        request.worktree,
        undefined,
        request.control,
      );
      if (!control) throw new Error("Remote control is unavailable");
      let launched: Awaited<ReturnType<typeof launchRemoteChild>> | undefined;
      try {
        launched = await launchRemoteChild(
          request,
          remote,
          defaults,
          this.hooksEnabled && this.agentHooks[request.agent] !== false,
          this.terminals,
          control,
          async () => {
            this.ensureOpen();
            await provider.validate?.();
            if (
              agentProvider(request.agent) !== provider ||
              (await this.worktrees.launchIdentity(request.repository, request.worktree)) !==
                checkoutIdentity
            )
              throw new Error("Worktree or provider changed");
          },
          this.remoteHooks,
        );
        if (this.earlyExits.has(launched.result.id)) {
          launched.dispose();
          if (![...this.launched.values()].includes(request.worktree))
            this.occupied.delete(request.worktree);
        } else {
          this.ensureOpen();
          this.launched.set(launched.result.id, request.worktree);
          this.mcpBindings.set(launched.result.id, launched);
        }
        return launched.result;
      } catch (error) {
        launched?.dispose();
        control.dispose();
        throw error;
      }
    }
    const scan =
      this.scannedRevision === providerRevision() && this.scanResult
        ? this.scanResult
        : await this.scan();
    const agent = scan.agents.find((entry) => entry.id === request.agent);
    if (!agent?.path)
      throw new Error(`${request.agent} is not installed. Rescan after installing it.`);
    const attach =
      this.hooksEnabled && this.agentHooks[agent.id] !== false && agent.hooks && this.prepareHooks;
    const suppliedBinding = attach ? await attach(agent.id) : undefined;
    let bindingDisposed = false;
    const binding = suppliedBinding
      ? {
          ...suppliedBinding,
          get env() {
            return suppliedBinding.env;
          },
          dispose: () => {
            if (bindingDisposed) return;
            bindingDisposed = true;
            suppliedBinding.dispose();
          },
        }
      : undefined;
    let control: ControlLaunch | undefined;
    let manual: ManualMcp | undefined;
    let prepared: PreparedLaunch | undefined;
    try {
      // Config sessions get no repository-scoped control grant.
      control =
        config === undefined
          ? await this.prepareControl?.(
              request.repository,
              request.worktree,
              binding?.env["FOOM_SESSION"],
              request.control,
            )
          : undefined;
      if (config !== undefined && agent.mcp) manual = await ManualMcp.listen();
      this.ensureOpen();
      if (
        config === undefined &&
        (await this.worktrees.launchIdentity(request.repository, request.worktree)) !==
          checkoutIdentity
      )
        throw new Error("Worktree has changed. Select it and try again.");
      if (request.control !== undefined && "role" in request.control && !control)
        throw new Error("Orchestration needs control credentials");
      prepared = await provider.prepareLaunch(
        agent,
        request,
        defaults,
        control ?? manual,
        config !== undefined,
        this.hooksEnabled && this.agentHooks[agent.id] !== false,
        binding,
      );
      const replacement = [...(binding?.v2?.channels.values() ?? [])].find(
        (channel) => channel.disclosure,
      );
      if (provider.origin === "bundled" && replacement?.disclosure)
        throw new Error(replacement.disclosure.text);
      if (
        request.control &&
        "role" in request.control &&
        !prepared.mcp &&
        !(request.conversationId === undefined && provider.model.launch.guidance)
      )
        throw new Error("This launch cannot restore orchestration without MCP");
      const args = prepared.args;
      const baseEnvironment = inheritedEnvironment();
      const environment = buildLaunchEnvironment({
        layers: [...(request.environment ?? []), prepared.environment ?? []],
        base: baseEnvironment,
        path: scan.path,
        pathFirst: config ?? control?.env["FOOM_CLI_DIRECTORY"],
        foom: { ...control?.env, ...manual?.env, ...binding?.env, ...request.configEnvironment },
      });
      const finalEnvironment = { ...baseEnvironment, ...environment.env };
      // The host inherits OS names such as ProgramFiles(x86) itself. IPC accepts
      // portable names only; freeze inspected inherited bypass names in that surface.
      const launchEnvironment =
        provider.origin !== "bundled"
          ? Object.fromEntries(
              Object.entries(finalEnvironment).filter(([name]) =>
                /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name),
              ),
            )
          : environment.env;
      const environmentMatches = bypassEnvironment(
        provider.model,
        finalEnvironment,
        process.platform === "win32",
      );
      const argumentMatches = provider.model.bypassArguments
        .filter((matcher) => matchesArguments([matcher], args))
        .map((matcher) => JSON.stringify(matcher));
      const argumentBypass = argumentMatches.length > 0;
      const bypass = argumentBypass || environmentMatches.length > 0;
      if (bypass) {
        if (request.control && "parentId" in request.control)
          throw new Error("Unattended child bypass is unavailable");
        if (
          (provider.origin !== "bundled" || environmentMatches.length > 0) &&
          !(await this.confirmLaunchBypass?.({
            title: `Launch ${provider.name} with bypass?`,
            glyph: "shield",
            subject: "This invocation",
            accept: "Launch with bypass",
            detail:
              "This agent can act as you anywhere on the machine. A worktree is not a sandbox. Manifest validation does not approve bypass for this launch.",
            sections: [
              {
                label: "Argument bypass matchers",
                arguments: true,
                items: argumentMatches.length ? argumentMatches : ["(none)"],
              },
              {
                label: "Environment bypass (names and predicates only)",
                items: environmentMatches.length ? environmentMatches : ["(none)"],
              },
            ],
          }))
        )
          throw new Error("Bypass launch was cancelled");
      }
      await provider.validate?.();
      if (
        config === undefined &&
        (await this.worktrees.launchIdentity(request.repository, request.worktree)) !==
          checkoutIdentity
      )
        throw new Error("Worktree has changed. Select it and try again.");
      if (agentProvider(request.agent) !== provider)
        throw new Error("Agent plugin changed. Review it again.");
      this.ensureOpen();
      request.beforeSpawn?.();
      const id = await this.terminals.create({
        ...(request.terminalId === undefined ? {} : { id: request.terminalId }),
        command: agent.path,
        args,
        cwd: request.worktree,
        cols: request.cols,
        rows: request.rows,
        env: launchEnvironment,
      });
      this.ensureOpen();
      if (this.earlyExits.has(id)) {
        if (![...this.launched.values()].includes(request.worktree))
          this.occupied.delete(request.worktree);
        manual?.dispose();
        control?.dispose();
        binding?.dispose();
        prepared.dispose();
        return {
          id,
          ...(provider.origin ? { providerOrigin: provider.origin } : {}),
          attention: binding ? "hooks" : "evaluator",
          ...(prepared.conversationId ? { conversationId: prepared.conversationId } : {}),
          bypass,
          ...(environment.names.length ? { environment: environment.names } : {}),
        };
      }
      this.launched.set(id, request.worktree);
      this.mcpBindings.set(id, prepared);
      if (manual) this.manuals.set(id, manual);
      if (control) {
        control.bind(id, prepared.mcp);
        this.controls.set(id, control);
      }
      if (binding) {
        this.bindings.set(id, binding);
        binding.bind?.(id);
      }
      return {
        id,
        ...(provider.origin ? { providerOrigin: provider.origin } : {}),
        attention: binding ? "hooks" : "evaluator",
        ...(prepared.conversationId ? { conversationId: prepared.conversationId } : {}),
        bypass,
        ...(environment.names.length ? { environment: environment.names } : {}),
      };
    } catch (error) {
      manual?.dispose();
      control?.dispose();
      binding?.dispose();
      prepared?.dispose();
      throw error;
    }
  }

  /** Call on terminal exit/kill. Revokes this launch's receiver credentials. */
  release(id: string): void {
    const worktree = this.launched.get(id);
    if (!worktree && this.starting > 0) this.earlyExits.add(id);
    this.manuals.get(id)?.dispose();
    this.manuals.delete(id);
    this.controls.get(id)?.dispose();
    this.controls.delete(id);
    this.mcpBindings.get(id)?.dispose();
    this.mcpBindings.delete(id);
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
