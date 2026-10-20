import type { ConfigStatus } from "../../shared/foom-config";
import { AgentProbes } from "../agents/probes";
import { ProbeHttp } from "../agents/probe-http";
import { ExecutionOwner } from "./execution-owner";
import { observerHealth } from "../agents/providers/installed-observers";
import { flushV2Health } from "../agents/providers/v2-health";
import { PluginSetup } from "../agents/plugin-setup";
import { stagePlugin } from "../agents/plugin-staging";
import { agentProvider, knownAgentId, providerRevision } from "../agents/providers/registry";
import { builtinAgent } from "../../shared/providers/catalog";
import { ControlError } from "../../node-common/control-validation";
import type { ForgeTracking } from "../control/forge-tracking";
import { CleanupOwner } from "./cleanup-owner";
import type { McpConnection } from "../../shared/workspace";
import { homeDirectory, homeShellFacts, shellPath } from "./home-shell";
import type { AgyPluginAction } from "../../shared/agy-plugin";
import { AgyPlugin } from "../agents/agy-plugin";
import type { ExecutionTransition } from "../../shared/execution";
import { conversationId, resumeArguments } from "../agents/conversation";
import { SessionOwner } from "./session-owner";
import type { SessionStore } from "./session-store";
import type { InventoryWatch } from "./inventory-watch";
import type { ControlLaunch } from "../control/types";
import { randomUUID } from "node:crypto";
import type { ActionLogPage } from "../../shared/action-log";
import type { ControlRuntime } from "../control/runtime";
import { Orchestration, UncertainEffect } from "../control/orchestration";
import type { ConfirmWorkspace, DialogContent } from "../../shared/confirmation";
import { EMPTY_AGENT_ARGUMENTS, hasBypassArgument } from "../agents/default-arguments";
import type { AgentEvidence } from "../../shared/agent-detection";
import { basename } from "node:path";
import type { SidebarCommand, SidebarInventory } from "../../shared/workspace";
import { AgentService, loginPath } from "../agents/agents";
import { AGENTS } from "../agents/agent-list";
import { buildLaunchEnvironment, inheritedEnvironment } from "../setup/environment";
import type { EnvironmentVariable } from "../../shared/environment";
import { prepareHookLaunch } from "../agents/providers/hook-launch";
import type { HookRegistrar } from "../agents/providers/hook-launch";
import type { AgentHooks, AgentId, AgentLaunch, AgentLaunched } from "../../shared/agents";
import type { TerminalSpec, ShellState } from "../../shared/desktop";
import type { EvaluationInput, VerdictAction, VerdictRecord } from "../../shared/evaluator";
import type { HookSignal } from "../../shared/hooks";
import type { Settings } from "../../shared/setup";
import type { BranchInventory, CreateOutcome, Repository, Worktree } from "../../shared/worktrees";
import type {
  AgentReport,
  StartWorktreeRequest,
  LaunchRequest,
  TerminalState,
  WorkspaceSnapshot,
  WorkspaceTerminal,
} from "../../shared/workspace";
import type { WorktreeService } from "./worktrees";

type Agents = Pick<AgentService, "scan" | "launch" | "release" | "dispose" | "setHooksEnabled">;
export interface WorkspaceDependencies {
  /** Main-owned clock budget; tests may inject a shorter probe reminder. */
  probeWaitingMs?: number;
  pluginStagingRoot?: string;
  worktrees: Pick<
    WorktreeService,
    | "listRepositories"
    | "addRepository"
    | "listWorktrees"
    | "branches"
    | "createWorktree"
    | "adoptWorktree"
    | "validateBranch"
    | "changes"
    | "removalIdentity"
    | "launchIdentity"
    | "removeWorktree"
    | "removeRepository"
    | "mergedDefault"
    | "mergedFetchTime"
    | "mergedCommit"
    | "deleteMergedBranch"
    | "deleteMergedBranches"
    | "canAutoRemove"
    | "panelFacts"
  >;
  terminals: {
    create(spec: TerminalSpec): Promise<string>;
    kill(id: string): Promise<void>;
    stop(id: string): Promise<void>;
    tail(id: string, lines: number): Promise<string[]>;
    reply?(id: string, data: string): Promise<void>;
    screen?(id: string): Promise<{ lines: string[]; title: string }>;
  };
  verdicts: {
    classify(input: EvaluationInput): Promise<VerdictRecord>;
    commit(record: VerdictRecord): Promise<void>;
    forget(terminalId: string): void;
    recordAction(terminalId: string, verdictId: string, action: VerdictAction): Promise<void>;
  };
  /** Started on the first agent launch, independently of hook support. */
  control?: () => Promise<
    Pick<ControlRuntime, "prepare" | "close" | "setRole"> &
      Partial<Pick<ControlRuntime, "audit" | "takeOver">>
  >;
  /** Started on the first launch that attaches hooks, then reused. */
  agentPluginDirectory?: string;
  receiver: () => Promise<HookRegistrar & { close(): Promise<void> }>;
  /** Release checkout resources before Git removal; restore availability afterward. */
  prepareWorktreeRemoval?(worktree: string): Promise<() => void>;
  onExecution?(event: ExecutionTransition): void;
  onState(state: TerminalState): void;
  onChange?(): void;
  watcher?: Pick<InventoryWatch, "sync" | "dispose">;
  acknowledgeNotifier(): Promise<void>;
  acknowledgeAgyPluginOffer?(): Promise<void>;
  forge?: ForgeTracking;
  openExternal?: (url: string) => Promise<void>;
  sessions?: Pick<SessionStore, "load" | "save" | "flush">;
  copyText?(text: string): void | Promise<void>;
  agents?: (
    prepare: (agent: AgentId) => Promise<AgentHooks>,
    control?: (
      repository: string,
      worktree: string,
      sessionId?: string,
      role?: AgentLaunch["control"],
    ) => Promise<ControlLaunch>,
  ) => Agents;
  /** The trusted app dialog, for confirmations no board click can answer. */
  dialog?: (content: DialogContent, signal: AbortSignal) => Promise<boolean>;
  /** Shows an existing session, for example a repository's running orchestrator. */
  reveal?: (id: string) => void;
  placeChild?: (id: string, parentId: string) => void;
  now?: () => number;
  /** Validated Environment layers for a launch: All sessions, then the agent's own. */
  environment?: (target: AgentId) => readonly (readonly EnvironmentVariable[])[];
  /** The Foom config folder: sessions there run without a repository or worktree. */
  config?: {
    root: string;
    cliDirectory: string;
    status?(): Promise<ConfigStatus>;
    probeNotice?(agent: string): Promise<boolean>;
    /** Throws when the folder is unavailable or sits inside a managed repository. */
    check(): Promise<void>;
  };
}

/**
 * Main-process integration: launches agents into managed worktrees, turns quiet events,
 * exits and hook signals into verdicts, and reports state. Terminal IDs are the only
 * identifiers crossing into evaluation; agent text never does.
 */
export class Workspace {
  /** Repository orchestrators and their children; the control service delegates here. */
  readonly orchestration: Orchestration;
  private readonly agents: Agents;
  private probes: AgentProbes | undefined;
  private readonly probeIds = new Set<string>();
  private probeHttp: Promise<ProbeHttp> | undefined;
  private readonly configTokens = new Map<string, string>();
  private readonly sessions: SessionOwner;
  private readonly cleanup: CleanupOwner;
  private readonly launched = new Map<string, WorkspaceTerminal>();
  private readonly executionOwner: ExecutionOwner;
  private readonly agyPlugin = new AgyPlugin();
  private readonly hookKeys = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();
  private control:
    | Promise<
        Pick<ControlRuntime, "prepare" | "close" | "setRole"> &
          Partial<Pick<ControlRuntime, "audit" | "takeOver">>
      >
    | undefined;
  private receiver: ReturnType<WorkspaceDependencies["receiver"]> | undefined;
  private scanned: ReturnType<Agents["scan"]> | undefined;
  private closed = false;
  private readonly launchAbort = new AbortController();
  private location: "root" | "adjacent" = "root";
  private acknowledged = false;
  private hooksEnabled = true;
  private agentHooks: Readonly<Record<string, boolean>> = {};
  private concurrentChildren = 4;
  private defaultArguments = EMPTY_AGENT_ARGUMENTS;
  private readonly resumeStarts = new Map<string, Promise<void>>();
  private readonly busySessions = new Set<string>();
  private readonly busyWorktrees = new Set<string>();
  private readonly repositoryOperations = new Map<string, Set<symbol>>();
  private readonly removingRepositories = new Set<string>();
  private enabled: Readonly<Record<AgentId, boolean>> = { claude: true, codex: true, agy: true };
  private readonly now: () => number;

  /** Publish credential-free discovery for humans even before the first agent launch. */
  async initializeControl(): Promise<void> {
    if (this.closed || !this.deps.control) return;
    this.control ??= this.deps.control().catch((error: unknown) => {
      this.control = undefined;
      throw error;
    });
    await this.control;
  }

  async actionLog(query: unknown): Promise<ActionLogPage> {
    await this.initializeControl();
    const audit = (await this.control)?.audit;
    if (!audit) throw new Error("Action log unavailable");
    return audit.read(query);
  }

  async clearActionLog(): Promise<void> {
    await this.initializeControl();
    const audit = (await this.control)?.audit;
    if (!audit) throw new Error("Action log unavailable");
    await audit.clearAudit();
  }

  private async auditHuman(
    action: string,
    id: string,
    target: string | null,
    status: string,
    operationId: string,
  ): Promise<void> {
    const entry = this.launched.get(id);
    await this.initializeControl();
    await (await this.control)?.audit?.human(
      action,
      id,
      entry?.repository ?? "",
      entry?.worktree ?? "",
      target ?? id,
      status,
      operationId,
    );
  }

  constructor(private readonly deps: WorkspaceDependencies) {
    this.now = deps.now ?? Date.now;
    deps.watcher?.sync(deps.worktrees.listRepositories());
    const prepare = async (agent: AgentId): Promise<AgentHooks> => {
      // A receiver that failed to start is retried on the next launch.
      this.receiver ??= deps.receiver().catch((error: unknown) => {
        this.receiver = undefined;
        throw error;
      });
      const binding = await prepareHookLaunch(
        await this.receiver,
        agent,
        (key, terminalId) => {
          if (terminalId) {
            this.hookKeys.set(key, terminalId);
            this.executionOwner.attachHooks(terminalId, binding.v2?.runtime);
          } else this.hookKeys.delete(key);
        },
        undefined,
        undefined,
        undefined,
        this.deps.agentPluginDirectory,
      );
      return binding;
    };
    const startControl = deps.control;
    const prepareControl = startControl
      ? async (
          repository: string,
          worktree: string,
          sessionId?: string,
          role?: AgentLaunch["control"],
        ): Promise<ControlLaunch> => {
          await this.initializeControl();
          const control = await this.control;
          if (!control) throw new Error("Control service unavailable");
          return role === undefined
            ? control.prepare(repository, worktree, sessionId)
            : "role" in role
              ? control.prepare(repository, worktree, sessionId, "orchestrator")
              : control.prepare(repository, worktree, sessionId, "agent", role.parentId);
        }
      : undefined;
    this.orchestration = new Orchestration(
      {
        ...(deps.forge === undefined ? {} : { forge: deps.forge }),
        terminals: () => this.snapshot().terminals,
        auditHandoff: async (actor, report) => {
          const audit = (await this.control)?.audit;
          if (!audit) throw new ControlError("unavailable");
          await audit.handoff(actor, report);
        },
        saveHandoffs: async () => {
          await this.sessions.save();
        },
        createWorktree: (repository, branch) => this.createChildWorktree(repository, branch),
        adoptWorktree: (repository, number, unused, revalidate) =>
          this.withRepository(repository, async () => {
            const key = `${repository}\0:adopt-pr-${String(number)}`;
            if (this.busyWorktrees.has(key)) throw new ControlError("branch_in_use");
            this.busyWorktrees.add(key);
            let branchKey: string | undefined;
            try {
              return await this.deps.worktrees.adoptWorktree(
                repository,
                number,
                unused,
                (path, branch) => {
                  if (branchKey === undefined) {
                    const candidate = `${repository}\0${branch ?? ""}`;
                    if (this.busyWorktrees.has(candidate)) throw new ControlError("branch_in_use");
                    branchKey = candidate;
                    this.busyWorktrees.add(candidate);
                  }
                  revalidate(path, branch);
                  if (this.snapshot().terminals.some((row) => row.worktree === path && !row.exited))
                    throw new ControlError("branch_in_use");
                },
                this.location,
              );
            } finally {
              this.busyWorktrees.delete(key);
              if (branchKey !== undefined) this.busyWorktrees.delete(branchKey);
              this.refresh();
            }
          }),
        launch: (parentId, repository, worktree, identity, agent, prompt) =>
          this.launchChild(parentId, repository, worktree, identity, agent, prompt),
        bypassDefaults: (agent) => hasBypassArgument(agent, this.defaultArguments[agent] ?? []),
        restoreWorktree: async (repository, path) => {
          if (path === repository) return undefined;
          const tree = (await this.deps.worktrees.listWorktrees(repository)).find(
            (item) => item.path === path,
          );
          if (!tree?.managed || tree.bare || tree.locked || tree.prunable || tree.branch === null)
            return undefined;
          const identity = await this.deps.worktrees.launchIdentity(repository, path);
          return { branch: tree.branch, identity };
        },
        stop: (id) => this.deps.terminals.stop(id),
        close: (id) => this.sidebarCommand({ kind: "close", id }, () => Promise.resolve(true)),
        place: (id, parentId) => this.deps.placeChild?.(id, parentId),
        starting: (id) => this.sessions.isRestoring(id),
        reply: async (id, data) => {
          if (!this.deps.terminals.reply) throw new Error("Reply adapter unavailable");
          this.input(id);
          await this.deps.terminals.reply(id, data);
        },
        reveal: (id) => this.deps.reveal?.(id),
        tail: (id, lines) => this.deps.terminals.tail(id, lines),
        remove: async (repository, worktree, identity, confirm, revalidate) => {
          return this.cleanup.removeOwnedTree(repository, worktree, identity, confirm, revalidate);
        },
        dialog: (content, signal) => this.deps.dialog?.(content, signal) ?? Promise.resolve(false),
        changed: () => {
          if (!this.closed) {
            this.persist();
            this.refresh();
          }
        },
      },
      this.now,
      () => this.concurrentChildren,
    );
    this.executionOwner = new ExecutionOwner({
      terminal: (id) => this.launched.get(id),
      tail: (id, lines) => deps.terminals.tail(id, lines),
      verdicts: deps.verdicts,
      enqueue: (id, work) => this.enqueue(id, work),
      closed: () => this.closed,
      refresh: () => {
        this.refresh();
      },
      recheck: (id) => {
        const entry = this.launched.get(id);
        if (entry?.kind === "agent") deps.forge?.recheck(entry.worktree);
      },
      exited: (id) => {
        this.revokeConfig(id);
        void this.probes?.exited(id).catch(() => undefined);
        this.persist();
      },
      invalidateReply: (id) => {
        this.orchestration.invalidateReply(id);
      },
      publishChildEvents: () => {
        this.orchestration.childEvents.publish();
      },
      waitingOn: (id) => this.orchestration.waitingOn(id),
      unreadAt: (id) => this.orchestration.unreadChildren.overdue(id),
      onExecution: (event) => {
        if (event.to === "working") {
          const token = this.configTokens.get(event.terminalId);
          if (token) this.probes?.dismiss(token);
        }
        deps.onExecution?.(event);
      },
      onState: (state) => {
        deps.onState(this.probeState(state.id, state) ?? state);
      },
      now: this.now,
    });
    const prepareWorktreeRemoval = deps.prepareWorktreeRemoval?.bind(deps);
    this.cleanup = new CleanupOwner({
      worktrees: deps.worktrees,
      inventory: (repository) => this.worktrees(repository),
      known: (repository) => {
        this.known(repository);
      },
      withRepository: (repository, work) => this.withRepository(repository, work),
      reserveRepositoryRemoval: (repository, validate) =>
        this.reserveRepositoryRemoval(repository, validate),
      withWorktreeRemoval: (...args) => this.removeTree(...args),
      releaseWorktree: (repository, branch) => {
        this.busyWorktrees.delete(`${repository}\0${branch ?? ""}`);
      },
      terminals: () => [...this.launched.values()],
      running: (id) =>
        this.sessions.isRestoring(id) ||
        (!this.launched.get(id)?.dormant && this.executionOwner.view(id).exitCode === undefined),
      exitCode: (id) => this.executionOwner.view(id).exitCode,
      stop: (id) => deps.terminals.stop(id),
      exited: (id, code) => this.exited(id, code),
      kill: (id) => deps.terminals.kill(id),
      removed: (id) => {
        this.removed(id);
      },
      ...(prepareWorktreeRemoval ? { prepareWorktreeRemoval } : {}),
      closed: () => this.closed,
      refresh: () => {
        this.refresh();
      },
      onChange: () => deps.onChange?.(),
      now: this.now,
    });
    this.sessions = new SessionOwner({
      ...(deps.sessions ? { store: deps.sessions } : {}),
      ...(deps.config ? { configRoot: deps.config.root } : {}),
      orchestration: this.orchestration,
      terminals: () => this.snapshot().terminals,
      terminal: (id) => this.launched.get(id),
      restoreRow: (row) => {
        this.launched.set(row.id, row);
        this.executionOwner.markExited(row.id, -1);
      },
      failed: (id) => {
        this.executionOwner.markExited(id, -1);
      },
      busy: (id, value) => {
        if (value) this.busySessions.add(id);
        else this.busySessions.delete(id);
      },
      closed: () => this.closed,
      identity: (repository) => deps.worktrees.launchIdentity(repository, repository),
      agents: async () => (await this.scanAgents(false)).agents,
      launch: async (entry, control, identity) => {
        const replacement = {
          id: entry.id,
          ...(entry.conversationId === undefined ? {} : { conversationId: entry.conversationId }),
        };
        const confirm: ConfirmWorkspace = () => Promise.resolve(false);
        if (entry.home) {
          await this.startHomeShell(entry.id);
          return undefined;
        }
        if (entry.config) {
          await this.startConfig(entry.agent, confirm, replacement);
          return undefined;
        }
        return this.startExisting(
          entry.repository,
          entry.worktree,
          entry.agent,
          confirm,
          replacement,
          control,
          true,
          identity,
        );
      },
      onChange: () => deps.onChange?.(),
    });
    this.agents = deps.agents
      ? deps.agents(prepare, prepareControl)
      : new AgentService(
          deps.worktrees,
          deps.terminals,
          prepare,
          prepareControl,
          this.agyPlugin,
          async (content) => {
            const approved = await deps.dialog?.(content, this.launchAbort.signal);
            return approved === true && !this.closed;
          },
        );
  }

  /** Setup's choices apply to later launches; running agents keep theirs. */
  configure(
    settings: Pick<Settings, "hooks" | "agents"> &
      Partial<
        Pick<
          Settings,
          | "worktreeLocation"
          | "codexNotifierAcknowledged"
          | "agentArguments"
          | "agentHooks"
          | "restoreSessions"
          | "concurrentChildren"
          | "unreadChildMinutes"
          | "autoRemoveMergedWorktrees"
          | "showPullRequests"
        >
      >,
  ): void {
    this.deps.forge?.setEnabled(settings.showPullRequests === true);
    this.sessions.configure(settings.restoreSessions ?? true);
    this.concurrentChildren = settings.concurrentChildren ?? 4;
    const reminderChanged = this.orchestration.unreadChildren.configure(
      settings.unreadChildMinutes ?? 5,
    );
    this.cleanup.configure(settings.autoRemoveMergedWorktrees ?? false);
    if (settings.agentHooks) this.agents.setHooksEnabled(settings.hooks, settings.agentHooks);
    else this.agents.setHooksEnabled(settings.hooks);
    this.agentHooks = settings.agentHooks ?? {};
    this.hooksEnabled = settings.hooks;
    this.defaultArguments = settings.agentArguments ?? EMPTY_AGENT_ARGUMENTS;
    if (JSON.stringify(this.enabled) !== JSON.stringify(settings.agents)) this.scanned = undefined;
    this.enabled = settings.agents;
    this.location = settings.worktreeLocation ?? "root";
    this.acknowledged = settings.codexNotifierAcknowledged ?? false;
    if (reminderChanged) this.refresh();
  }

  async restore(): Promise<void> {
    await this.sessions.restore();
  }

  ownsSession(id: string): boolean {
    return this.launched.has(id);
  }

  private persist(): void {
    this.sessions.persist();
  }

  /** Freeze the pre-shutdown state, before stopping PTYs reports their exits. */
  async prepareQuit(): Promise<void> {
    await this.sessions.prepareQuit();
  }

  cancelQuit(): void {
    this.sessions.cancelQuit();
  }

  /** Called only after all saved windows have been shown. */
  restartSaved(): Promise<void> {
    return this.sessions.restartSaved();
  }

  private readonly mcpConnections = new Map<string, McpConnection>();

  mcpConnectionChanged(id: string, state: McpConnection | undefined): void {
    if (state === undefined) this.mcpConnections.delete(id);
    else this.mcpConnections.set(id, state);
    this.refresh();
  }

  private probeState(id: string, state: TerminalState | null): TerminalState | null {
    if (state?.state === "needs_input") return state;
    const token = this.configTokens.get(id);
    const at = token ? this.probes?.waitingAt(token) : undefined;
    return at === undefined
      ? state
      : {
          id,
          execution: this.executionOwner.view(id).execution,
          verdictId: null,
          state: "needs_input",
          reason: "Probe waiting",
          signal: "probe:waiting",
          confidence: 1,
          timestamp: at,
          attentionKind: "unknown",
        };
  }
  snapshot(): WorkspaceSnapshot {
    return {
      repositories: this.deps.worktrees.listRepositories(),
      terminals: [...this.launched.values()].map((entry) => {
        const view = this.executionOwner.view(entry.id);
        return {
          ...entry,
          ...(view.execution ? { execution: view.execution } : {}),
          ...(view.exitCode !== undefined ? { exitCode: view.exitCode } : {}),
          foregroundProgram: view.exitCode === undefined ? (view.foregroundProgram ?? "") : "",
          state: this.probeState(entry.id, this.executionOwner.currentState(entry.id)),
          outputRevision: view.outputRevision,
          inputRevision: view.inputRevision,
          exited:
            !this.sessions.isRestoring(entry.id) &&
            (entry.dormant === true || view.exitCode !== undefined),
          ...this.orchestrationView(entry.id),
          ...(this.sessions.roleNotRestored(entry.id) ? { roleNotRestored: true } : {}),
          mcpConnection: this.mcpConnections.get(entry.id),
        };
      }),
    };
  }

  async addRepository(path: string): Promise<Repository> {
    const repository = await this.deps.worktrees.addRepository(path);
    this.refresh();
    return repository;
  }

  focusOrchestrator(id: string): void {
    this.orchestration.syncUnreadChildEvents();
    if (this.orchestration.unreadChildren.read(id)) this.refresh();
  }

  refresh(): void {
    if (this.closed) return;
    this.orchestration.syncUnreadChildEvents();
    this.orchestration.childEvents.publish();
    this.deps.watcher?.sync(this.deps.worktrees.listRepositories());
    this.deps.onChange?.();
  }

  private known(repository: string): void {
    if (!this.deps.worktrees.listRepositories().some((entry) => entry.path === repository))
      throw new Error("Repository has not been added");
  }

  /** Reserve registration before any async work; independent launches can still overlap. */
  private async withRepository<T>(repository: string, work: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("Workspace is closed");
    this.known(repository);
    if (this.removingRepositories.has(repository))
      throw new Error("Repository removal is in progress");
    const operations = this.repositoryOperations.get(repository) ?? new Set<symbol>();
    const operation = Symbol();
    operations.add(operation);
    this.repositoryOperations.set(repository, operations);
    try {
      return await work();
    } finally {
      operations.delete(operation);
      if (operations.size === 0) this.repositoryOperations.delete(repository);
    }
  }

  /** Used by both sidebar confirmation and Settings repository selection. */
  async removeRepository(repository: string, confirm?: () => Promise<boolean>): Promise<void> {
    return this.cleanup.removeRepository(repository, confirm);
  }

  private reserveRepositoryRemoval(repository: string, validate: () => void): () => void {
    if (this.closed) throw new Error("Workspace is closed");
    this.known(repository);
    if (this.removingRepositories.has(repository) || this.repositoryOperations.has(repository))
      throw new Error("Repository is busy. Try again when its current operation finishes.");
    validate();
    this.removingRepositories.add(repository);
    return () => {
      this.removingRepositories.delete(repository);
    };
  }

  async worktrees(repository: string): Promise<readonly Worktree[]> {
    this.known(repository);
    return this.deps.worktrees.listWorktrees(repository);
  }

  async branches(repository: string): Promise<BranchInventory> {
    this.known(repository);
    return this.deps.worktrees.branches(repository);
  }

  /** Create only: nothing launches. Without a location, the configured one applies. */
  async createWorktree(
    repository: string,
    branch: string,
    location: "root" | "adjacent" = this.location,
  ): Promise<Worktree & { outcome: CreateOutcome }> {
    return this.withRepository(repository, async () => {
      const key = `${repository}\0${branch}`;
      if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
      this.busyWorktrees.add(key);
      try {
        const created = await this.addWorktree(repository, branch, location);
        this.refresh();
        return created;
      } finally {
        this.busyWorktrees.delete(key);
      }
    });
  }

  private async addWorktree(
    repository: string,
    branch: string,
    location: "root" | "adjacent",
  ): Promise<Worktree & { outcome: CreateOutcome }> {
    const { path, outcome } = await this.deps.worktrees.createWorktree(repository, branch, {
      location,
    });
    const created = (await this.deps.worktrees.listWorktrees(repository)).find(
      (tree) => tree.path === path,
    );
    if (!created) throw new Error("Created worktree is missing");
    return { ...created, outcome };
  }

  private scannedProviders = -1;
  async scanAgents(refresh: boolean): Promise<AgentReport> {
    if (refresh || this.scannedProviders !== providerRevision()) this.scanned = undefined;
    this.scannedProviders = providerRevision();
    this.scanned ??= this.agents.scan(this.enabled);
    try {
      const { warning, agents } = await this.scanned;
      return {
        warning,
        agents: await Promise.all(
          agents.map(async (agent) => {
            if (!knownAgentId(agent.id)) return agent;
            const provider = agentProvider(agent.id);
            if (!agent.path || !provider.model.health) return agent;
            const health = agent.healthSupported
              ? await observerHealth(
                  provider.model,
                  this.deps.agentPluginDirectory,
                  provider.origin === "bundled",
                ).catch(() => undefined)
              : undefined;
            return {
              ...agent,
              ...(agent.healthSupported
                ? {
                    hookState: health?.get() ?? "not-reviewed",
                    healthInstructions: provider.model.health.instructions,
                  }
                : {}),
              notifierReplacement: provider.needsNotifier(
                agent,
                undefined,
                health?.get() === "trusted",
              ),
            };
          }),
        ),
      };
    } catch (error) {
      this.scanned = undefined;
      throw error;
    }
  }
  async changeAgentSetup(
    id: string,
    action: string,
    confirm: (content: DialogContent) => Promise<boolean>,
  ): Promise<AgentReport> {
    const provider = agentProvider(id);
    const model = provider.model;
    if (!model.setup) throw new Error("Agent setup is unavailable");
    const revision = providerRevision();
    const report = await this.scanAgents(true);
    const executable = report.agents.find((entry) => entry.id === id)?.path;
    if (!executable) throw new Error("Agent is not installed");
    const service = new PluginSetup();
    try {
      await service.change({
        model,
        executable,
        action,
        signal: this.launchAbort.signal,
        facts: (state) =>
          provider.setupFacts?.(executable, {
            hooksEnabled: this.hooksEnabled && this.agentHooks[id] !== false,
            healthTrusted: false,
            setupState: state ?? "unavailable",
          }) ?? {},
        validate: async () => {
          if (this.closed || revision !== providerRevision() || agentProvider(id) !== provider)
            throw new Error("Agent plugin changed. Scan again.");
          await provider.validate?.();
          const current = await this.scanAgents(true);
          if (current.agents.find((entry) => entry.id === id)?.path !== executable)
            throw new Error("Agent executable changed. Scan again.");
        },
        confirm,
        stage: () => {
          if (!this.deps.pluginStagingRoot) throw new Error("Plugin staging is unavailable");
          return stagePlugin(
            model,
            this.deps.pluginStagingRoot,
            provider.setupFacts?.(executable, {
              setupState: report.agents.find((entry) => entry.id === id)?.setup?.state,
              hooksEnabled: this.hooksEnabled && this.agentHooks[id] !== false,
              healthTrusted: false,
            }) ?? {},
          );
        },
      });
    } finally {
      this.scanned = undefined;
    }
    this.deps.onChange?.();
    return this.scanAgents(true);
  }

  async changeAgyPlugin(
    action: AgyPluginAction,
    confirm: () => Promise<boolean> = () => Promise.resolve(false),
  ): Promise<AgentReport> {
    const report = await this.scanAgents(true);
    const executable = report.agents.find((agent) => builtinAgent(agent.id)?.pluginSetup)?.path;
    if (!executable) throw new Error("Antigravity is not installed");
    if (action === "install" || action === "update") {
      const accepted = await confirm();
      await this.deps.acknowledgeAgyPluginOffer?.();
      if (!accepted) return report;
    }
    try {
      await this.agyPlugin.change(executable, action);
    } finally {
      this.scanned = undefined;
    }
    this.deps.onChange?.();
    return this.scanAgents(true);
  }

  private async confirmAgentLaunch(worktree: string, confirm: ConfirmWorkspace): Promise<boolean> {
    const active = [...this.launched.values()].some(
      (entry) =>
        entry.worktree === worktree &&
        entry.kind === "agent" &&
        this.executionOwner.view(entry.id).exitCode === undefined,
    );
    return !active || confirm({ kind: "shared-agent" });
  }

  async launch(
    request: LaunchRequest,
    confirm: ConfirmWorkspace = () => Promise.resolve(false),
  ): Promise<{ id: string; attention: "hooks" | "evaluator" } | null> {
    return this.withRepository(request.repository, async () => {
      const tree = (await this.worktrees(request.repository)).find(
        (item) => item.path === request.worktree,
      );
      const key = `${request.repository}\0${tree?.branch ?? ""}`;
      if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
      this.busyWorktrees.add(key);
      try {
        const identity = await this.deps.worktrees.launchIdentity(
          request.repository,
          request.worktree,
        );
        if (!(await this.confirmAgentLaunch(request.worktree, confirm))) return null;
        return await this.launchAgent(request, false, true, identity);
      } finally {
        this.busyWorktrees.delete(key);
      }
    });
  }

  private async launchAgent(
    request: LaunchRequest,
    mainCheckout = false,
    sharedCheckout = false,
    checkoutIdentity?: string,
    replacement?: { id: string; conversationId?: string },
    extra: Pick<AgentLaunch, "control" | "prompt" | "conversationId" | "pinConversation"> = {},
  ): Promise<{ id: string; attention: "hooks" | "evaluator" }> {
    return this.withRepository(request.repository, async () => {
      if (this.enabled[request.agent] === false)
        throw new Error("This agent is turned off in preflight");
      // Scan once so launches don't each probe the login shell.
      await this.scanAgents(false);
      // Look up the branch before spawning, so nothing can fail between spawn and tracking.
      const tree = (await this.deps.worktrees.listWorktrees(request.repository)).find(
        (entry) => entry.path === request.worktree,
      );
      // Children use the user's defaults as written, but never bypass: an orchestrator
      // cannot pass on the user's acknowledgement for manual launches.
      const child = extra.control !== undefined && "parentId" in extra.control;
      const defaultArguments = this.defaultArguments[request.agent] ?? [];
      if (child && hasBypassArgument(request.agent, defaultArguments))
        throw new ControlError("forbidden");
      const result = await this.agents.launch({
        ...request,
        ...extra,
        defaultArguments,
        ...(replacement
          ? {
              terminalId: replacement.id,
              ...(replacement.conversationId === undefined
                ? {}
                : { conversationId: replacement.conversationId }),
            }
          : {}),
        mainCheckout,
        sharedCheckout,
        ...(checkoutIdentity !== undefined ? { checkoutIdentity } : {}),
        ...(this.deps.environment ? { environment: this.deps.environment(request.agent) } : {}),
      });
      const launchVersion = replacement
        ? (this.launched.get(replacement.id)?.launchVersion ?? 0) + 1
        : undefined;
      if (extra.control && "role" in extra.control && checkoutIdentity !== undefined)
        this.sessions.rememberIdentity(request.repository, checkoutIdentity);
      this.launched.set(result.id, {
        ...(launchVersion === undefined ? {} : { launchVersion }),
        id: result.id,
        ...(result.providerOrigin ? { providerOrigin: result.providerOrigin } : {}),
        startedAt: this.now(),
        launchFlags: [...defaultArguments],
        ...(result.environment?.length ? { environment: [...result.environment] } : {}),
        kind: "agent",
        agent: request.agent,
        repository: request.repository,
        worktree: request.worktree,
        branch: tree?.branch ?? null,
        attention: result.attention,
        ...((replacement?.conversationId ?? extra.conversationId) === undefined
          ? {}
          : { conversationId: replacement?.conversationId ?? extra.conversationId }),
        ...(result.conversationId ? { conversationId: result.conversationId } : {}),
        bypass: result.bypass ?? hasBypassArgument(request.agent, defaultArguments),
        state: null,
      });
      this.executionOwner.launched(result.id);
      this.persist();
      this.refresh();
      return { id: result.id, attention: result.attention };
    });
  }

  async startWorktree(
    request: StartWorktreeRequest,
    confirm: ConfirmWorkspace = () => Promise.resolve(false),
  ): Promise<string | null> {
    return this.withRepository(request.repository, async () => {
      // Lock the logical branch before any async operation, including creation.
      const key = `${request.repository}\0${request.branch}`;
      if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
      this.busyWorktrees.add(key);
      try {
        await this.deps.worktrees.validateBranch(request.repository, request.branch);
        const trees = await this.worktrees(request.repository);
        const existing = trees.find((tree) => tree.branch === request.branch);
        const tree =
          existing ?? (await this.addWorktree(request.repository, request.branch, this.location));
        if (tree.bare || tree.locked || tree.prunable) throw new Error("Worktree is unavailable");
        const identity = await this.deps.worktrees.launchIdentity(request.repository, tree.path);
        if (request.run !== "shell") {
          if (!(await this.confirmAgentLaunch(tree.path, confirm))) return null;
          if (
            builtinAgent(request.run)?.hookHealth &&
            request.acknowledgeNotifierReplacement &&
            !this.acknowledged
          ) {
            await this.deps.acknowledgeNotifier();
            this.acknowledged = true;
          }
          return (
            await this.launchAgent(
              {
                agent: request.run,
                repository: request.repository,
                worktree: tree.path,
                cols: 80,
                rows: 24,
                acknowledgeNotifierReplacement: this.acknowledged,
              },
              false,
              true,
              identity,
            )
          ).id;
        }
        if ((await this.deps.worktrees.launchIdentity(request.repository, tree.path)) !== identity)
          throw new Error("Worktree has changed. Select it and try again.");
        return await this.startShell({
          repository: request.repository,
          worktree: tree.path,
          branch: tree.branch,
        });
      } finally {
        this.busyWorktrees.delete(key);
      }
    });
  }

  async removeWorktree(
    id: string,
    confirm: (branch: string, changes: string) => Promise<boolean>,
  ): Promise<boolean> {
    const entry = this.launched.get(id);
    if (!entry) throw new Error("Unknown worktree terminal");
    return this.cleanup.removeIdleTree(entry.repository, entry.worktree, entry.branch, confirm);
  }

  /** Shared launch/removal reservation; cleanup owns the removal sequence. */
  private async removeTree(
    repository: string,
    worktree: string,
    branch: string | null,
    confirm: (branch: string, changes: string, automatic?: boolean) => Promise<boolean>,
    revalidate?: () => void | Promise<void>,
    retainBranchLock = false,
    autoApprove?: () => Promise<boolean>,
  ): Promise<boolean> {
    const key = `${repository}\0${branch ?? ""}`;
    if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
    this.busyWorktrees.add(key);
    let removed = false;
    try {
      removed = await this.cleanup.removeReservedTree(
        repository,
        worktree,
        branch,
        confirm,
        revalidate,
        autoApprove,
      );
      return removed;
    } finally {
      if (!retainBranchLock || !removed) this.busyWorktrees.delete(key);
    }
  }

  private homeFacts: ReturnType<typeof homeShellFacts> | undefined;
  panelFacts(repository: string, worktree: string) {
    this.known(repository);
    return this.deps.worktrees.panelFacts(repository, worktree);
  }

  /** Shells get the All sessions layer only; `pathFirst` stays ahead of its PATH entries. */
  private async shellEnvironment(
    pathFirst?: string,
  ): Promise<{ env: Record<string, string>; names: string[] }> {
    const layers = this.deps.environment?.("shell") ?? [];
    const path = pathFirst === undefined ? undefined : (await loginPath()).path;
    return buildLaunchEnvironment({ layers, base: inheritedEnvironment(), pathFirst, path });
  }

  /**
   * Reusing a terminal ID resets the renderer's row and advances its launch version.
   * Advance main's too, or the renderer treats every later snapshot of the row as stale.
   */
  private replacementVersion(id: string | undefined): Pick<WorkspaceTerminal, "launchVersion"> {
    return id === undefined
      ? {}
      : { launchVersion: (this.launched.get(id)?.launchVersion ?? 0) + 1 };
  }

  /** Shared shell launch path; callers validate their location before spawning. */
  private async startShell(
    location: Pick<WorkspaceTerminal, "repository" | "worktree" | "branch" | "home" | "config">,
    restoreId?: string,
    pathFirst?: string,
    configEnvironment?: Readonly<Record<string, string>>,
  ): Promise<string> {
    const environment = await this.shellEnvironment(pathFirst);
    if (restoreId !== undefined) this.executionOwner.reset(restoreId);
    const id = await this.deps.terminals.create({
      ...(restoreId === undefined ? {} : { id: restoreId }),
      command: shellPath(),
      args: process.platform === "win32" ? ["-NoLogo"] : ["-l"],
      shellIntegration: true,
      env: { ...environment.env, ...configEnvironment },
      cwd: location.worktree,
      cols: 80,
      rows: 24,
    });
    this.launched.set(id, {
      ...this.replacementVersion(restoreId),
      id,
      kind: "shell",
      agent: "shell",
      ...location,
      ...(environment.names.length ? { environment: environment.names } : {}),
      attention: "evaluator",
      state: null,
      startedAt: this.now(),
    });
    this.executionOwner.ensure(id);
    this.persist();
    this.refresh();
    return id;
  }

  private async startHomeShell(restoreId?: string): Promise<void> {
    await this.startShell(
      { home: true, repository: homeDirectory, worktree: homeDirectory, branch: null },
      restoreId,
    );
  }

  private revokeConfig(id: string): void {
    const token = this.configTokens.get(id);
    if (!token) return;
    this.configTokens.delete(id);
    void this.probes?.revoke(token).catch(() => undefined);
  }
  private bindConfig(id: string, token: string): void {
    this.configTokens.set(id, token);
    if (this.executionOwner.view(id).exitCode !== undefined) this.revokeConfig(id);
  }
  private ensureProbeOpen(): void {
    if (this.closed) throw new Error("Foom config unavailable");
  }
  private async configCredential(): Promise<{ token: string; env: Record<string, string> }> {
    const config = this.deps.config;
    if (!config || this.closed) throw new Error("Foom config unavailable");
    this.probes ??= new AgentProbes(
      {
        configStatus: async () => {
          if (!config.status) throw new Error("Foom config status unavailable");
          return config.status();
        },
        waitingChanged: () => {
          this.refresh();
        },
        create: async (spec) => {
          if (spec.id) this.probeIds.add(spec.id);
          try {
            return await this.deps.terminals.create(spec);
          } catch (error) {
            if (spec.id) this.probeIds.delete(spec.id);
            throw error;
          }
        },
        stop: (id) => this.deps.terminals.stop(id),
        kill: (id) => this.deps.terminals.kill(id),
        reply: async (id, data) => {
          if (!this.deps.terminals.reply) throw new Error("Probe input unavailable");
          this.input(id);
          await this.deps.terminals.reply(id, data);
        },
        screen: async (id) => {
          if (!this.deps.terminals.screen) throw new Error("Probe screen unavailable");
          return this.deps.terminals.screen(id);
        },
        show: async (id, agent, conversationId, owner, cwd, assertActive) => {
          const note = (await config.probeNotice?.(agent)) ?? false;
          assertActive();
          if (this.closed) throw new Error("Foom config unavailable");
          if (this.executionOwner.view(id).exitCode !== undefined)
            throw new Error("Probe exited during startup");
          const parent = [...this.configTokens].find(([, token]) => token === owner)?.[0];
          this.launched.set(id, {
            id,
            ...(parent ? { probeOwner: parent } : {}),
            kind: "agent",
            agent,
            config: true,
            probe: true,
            probeNote: note,
            repository: config.root,
            worktree: cwd,
            branch: null,
            attention: "evaluator",
            state: null,
            startedAt: this.now(),
            ...(conversationId === undefined ? {} : { conversationId }),
          });
          this.executionOwner.launched(id);
          this.refresh();
          if (parent) this.deps.placeChild?.(id, parent);
        },
        removed: (id) => {
          this.removed(id);
        },
      },
      config.root,
      undefined,
      undefined,
      this.deps.probeWaitingMs,
      this.now,
    );
    this.probeHttp ??= ProbeHttp.listen(this.probes).catch((error: unknown) => {
      this.probeHttp = undefined;
      throw error;
    });
    const http = await this.probeHttp;
    this.ensureProbeOpen();
    const token = this.probes.grant();
    return { token, env: { FOOM_CONFIG_TOKEN: token, FOOM_CONFIG_URL: http.url } };
  }

  /** Config sessions have no worktree or repository grants. */
  private async startConfig(
    run: AgentId,
    confirm: ConfirmWorkspace,
    replacement?: { id: string; conversationId?: string },
  ): Promise<void> {
    const config = this.deps.config;
    if (!config) throw new Error("Foom config is unavailable");
    await config.check();
    if (run === "shell") {
      const credential = await this.configCredential();
      try {
        const id = await this.startShell(
          { config: true, repository: config.root, worktree: config.root, branch: null },
          replacement?.id,
          config.cliDirectory,
          credential.env,
        );
        this.bindConfig(id, credential.token);
      } catch (error) {
        await this.probes?.revoke(credential.token);
        throw error;
      }
      return;
    }
    if (this.enabled[run] === false) throw new Error("This agent is turned off in preflight");
    const scan = await this.scanAgents(false);
    if (
      builtinAgent(run)?.hookHealth &&
      this.hooksEnabled &&
      this.agentHooks[run] !== false &&
      !this.acknowledged &&
      scan.agents.some(
        (agent) => agent.id === run && agent.hooks && agent.notifierReplacement === true,
      )
    ) {
      if (!(await confirm({ kind: "notifier" }))) return;
      await this.deps.acknowledgeNotifier();
      this.acknowledged = true;
    }
    if (replacement) {
      const old = this.launched.get(replacement.id);
      if (!old || this.executionOwner.view(old.id).exitCode === undefined)
        throw new Error("Session is no longer exited");
      await this.queues.get(old.id);
      if (!old.dormant) await this.deps.terminals.kill(old.id);
      old.dormant = true;
      this.executionOwner.reset(old.id);
      this.deps.verdicts.forget(old.id);
    }
    const defaultArguments = this.defaultArguments[run] ?? [];
    let result: AgentLaunched;
    const credential = await this.configCredential();
    try {
      result = await this.agents.launch({
        agent: run,
        configEnvironment: credential.env,
        repository: config.root,
        worktree: config.root,
        cols: 80,
        rows: 24,
        defaultArguments,
        configCli: config.cliDirectory,
        sharedCheckout: true,
        acknowledgeNotifierReplacement: this.acknowledged,
        ...(this.deps.environment ? { environment: this.deps.environment(run) } : {}),
        ...(replacement
          ? {
              terminalId: replacement.id,
              ...(replacement.conversationId === undefined
                ? {}
                : { conversationId: replacement.conversationId }),
            }
          : {}),
      });
    } catch (error) {
      await this.probes?.revoke(credential.token);
      if (replacement) this.executionOwner.markExited(replacement.id, -1);
      this.deps.onChange?.();
      throw error;
    }
    this.bindConfig(result.id, credential.token);
    const launchVersion = replacement
      ? (this.launched.get(replacement.id)?.launchVersion ?? 0) + 1
      : undefined;
    this.launched.set(result.id, {
      ...(launchVersion === undefined ? {} : { launchVersion }),
      id: result.id,
      ...(result.providerOrigin ? { providerOrigin: result.providerOrigin } : {}),
      startedAt: this.now(),
      launchFlags: [...defaultArguments],
      ...(result.environment?.length ? { environment: [...result.environment] } : {}),
      kind: "agent",
      agent: run,
      config: true,
      repository: config.root,
      worktree: config.root,
      branch: null,
      attention: result.attention,
      ...(replacement?.conversationId === undefined
        ? {}
        : { conversationId: replacement.conversationId }),
      ...(result.conversationId ? { conversationId: result.conversationId } : {}),
      bypass: result.bypass ?? hasBypassArgument(run, defaultArguments),
      state: null,
    });
    this.executionOwner.launched(result.id);
    this.persist();
    this.refresh();
  }

  async sidebarInventory(): Promise<SidebarInventory> {
    return {
      previews: [],
      home: await (this.homeFacts ??= homeShellFacts()),
      repositories: await Promise.all(
        this.deps.worktrees.listRepositories().map(async (repository) => {
          const worktrees = await this.worktrees(repository.path);
          if (this.deps.forge?.boardEnabled) {
            const tracked = await Promise.all(
              worktrees
                .filter((tree) => tree.branch && !tree.bare && !tree.prunable)
                .map(async (tree) => {
                  const identity = await this.deps.worktrees
                    .launchIdentity(repository.path, tree.path)
                    .catch(() => undefined);
                  return identity && tree.branch
                    ? {
                        repository: repository.path,
                        path: tree.path,
                        identity,
                        branch: tree.branch,
                      }
                    : undefined;
                }),
            );
            this.deps.forge.sync(
              repository.path,
              tracked.filter((tree) => tree !== undefined),
            );
          }
          const { removedWorktrees, ...eligibility } = this.cleanup.inventory(
            repository.path,
            worktrees,
          );
          return {
            ...repository,
            worktrees: [
              ...worktrees.map((tree) => {
                const pullRequest = this.deps.forge?.readBoard(repository.path, tree.path);
                return pullRequest ? { ...tree, pullRequest } : tree;
              }),
              ...removedWorktrees,
            ],
            ...eligibility,
          };
        }),
      ),
      shell:
        process.platform === "win32"
          ? "powershell.exe"
          : basename(process.env["SHELL"] || "/bin/bash"),
    };
  }

  async sidebarCommand(
    command: Exclude<SidebarCommand, { kind: "open-handoff-link" }>,
    confirm: ConfirmWorkspace,
  ): Promise<void> {
    if (this.closed) throw new Error("Workspace is closed");
    if (command.kind === "resume-id") return this.resumeId(command, confirm);
    if (command.kind === "home-shell") return this.startHomeShell();
    if (command.kind === "config-launch") return this.startConfig(command.run, confirm);
    if (command.kind === "copy-config-path") {
      if (!this.deps.config) throw new Error("Foom config is unavailable");
      await this.deps.copyText?.(this.deps.config.root);
      return;
    }
    if (command.kind === "copy-home-path") {
      await this.deps.copyText?.(homeDirectory);
      return;
    }
    if (command.kind === "open-pull-request") {
      await this.deps.worktrees.launchIdentity(command.repository, command.worktree);
      const pr = this.deps.forge?.readBoard(command.repository, command.worktree);
      if (!pr) throw new Error("Pull request unavailable");
      await this.deps.openExternal?.(pr.url);
      return;
    }
    if (command.kind === "copy-worktree-path") {
      await this.deps.worktrees.launchIdentity(command.repository, command.worktree);
      await this.deps.copyText?.(command.worktree);
      return;
    }
    if (command.kind === "reset-replies") {
      const view = this.orchestration.view(command.id);
      if (view?.role !== "child" || view.takenOver)
        throw new Error("This session has no orchestrator");
      this.orchestration.resetReplies(command.id);
      return;
    }
    if (command.kind === "take-over") {
      const operationId = randomUUID();
      await this.auditHuman("take_over", command.id, command.id, "running", operationId);
      try {
        this.orchestration.takeOver(command.id);
        (await this.control)?.takeOver?.(command.id);
      } catch (error) {
        await this.auditHuman("take_over", command.id, command.id, "refused", operationId);
        throw error;
      }
      await this.auditHuman("take_over", command.id, command.id, "succeeded", operationId);
      return;
    }
    if (command.kind === "make-orchestrator") return this.makeOrchestrator(command.id, confirm);
    if (command.kind === "revoke-orchestrator") return this.revokeOrchestrator(command.id);
    if ("id" in command && this.busySessions.has(command.id)) throw new Error("Session is busy");
    if (
      command.kind === "resume" ||
      command.kind === "new-conversation" ||
      command.kind === "copy-session-id"
    ) {
      const entry = this.launched.get(command.id);
      if (!entry || entry.agent === "shell") throw new Error("Unknown agent session");
      if (command.kind === "copy-session-id") {
        if (!conversationId(entry.conversationId)) throw new Error("No conversation ID recorded");
        await this.deps.copyText?.(entry.conversationId);
        return;
      }
      if (this.executionOwner.view(entry.id).exitCode === undefined)
        throw new Error("Session is still running");
      if (command.kind === "resume") resumeArguments(entry.agent, entry.conversationId);
      this.busySessions.add(entry.id);
      try {
        const replacement = {
          id: entry.id,
          ...(command.kind === "resume" && entry.conversationId !== undefined
            ? { conversationId: entry.conversationId }
            : {}),
        };
        if (entry.config) await this.startConfig(entry.agent, confirm, replacement);
        else
          await this.startExisting(
            entry.repository,
            entry.worktree,
            entry.agent,
            confirm,
            replacement,
          );
      } finally {
        this.busySessions.delete(entry.id);
      }
      return;
    }
    if (command.kind === "stop" || command.kind === "close" || command.kind === "restart") {
      const entry = this.launched.get(command.id);
      if (!entry && command.kind !== "stop" && command.kind !== "close")
        throw new Error("Unknown session");
      const exited = this.executionOwner.view(command.id).exitCode !== undefined;
      if (command.kind === "stop") {
        if (!(await confirm({ kind: "stop" }))) return;
        await this.deps.terminals.stop(command.id);
        return;
      }
      if (!exited) throw new Error("Session is still running");
      if (
        command.kind === "close" &&
        this.snapshot().terminals.some(
          (row) => row.orchestration?.role === "child" && row.orchestration.parentId === command.id,
        )
      )
        throw new Error("Close the orchestrator's children first to keep their parent context");
      if (command.kind === "restart") {
        if (!entry || entry.kind !== "shell") throw new Error("Only shells can restart");
        if (entry.config) await this.startConfig("shell", confirm);
        else if (entry.home) await this.startHomeShell();
        else await this.startExisting(entry.repository, entry.worktree, "shell", confirm);
      }
      if (!entry?.dormant) await this.deps.terminals.kill(command.id);
      this.removed(command.id);
      return;
    }
    this.known(command.repository);
    if (command.kind === "delete-merged-worktrees")
      return this.cleanup.deleteMerged(command.repository, confirm);
    if (command.kind === "remove-repository") {
      return this.removeRepository(command.repository, () => confirm({ kind: "remove" }));
    }
    if (command.kind === "launch") {
      await this.startExisting(command.repository, command.worktree, command.run, confirm);
      return;
    }
    const tree = (await this.worktrees(command.repository)).find(
      (item) => item.path === command.worktree,
    );
    if (!tree) throw new Error("Worktree was removed. Choose another checkout.");
    if (tree.path === command.repository)
      throw new Error("Worktree is missing or is the main checkout");
    await this.cleanup.removeIdleTree(
      command.repository,
      tree.path,
      tree.branch,
      (branch, changes) =>
        confirm(
          changes
            ? { kind: "dirty-worktree", title: `Remove ${branch}?`, branch, changes }
            : { kind: "remove" },
        ),
    );
    this.refresh();
  }

  private async resumeId(
    command: Extract<SidebarCommand, { kind: "resume-id" }>,
    confirm: ConfirmWorkspace,
  ): Promise<void> {
    const { checkout, agent, id } = command;
    resumeArguments(agent, id);
    const key = `${agent}\0${id}`;
    // Serialize by conversation across checkouts, including confirmations and spawn.
    const previous = this.resumeStarts.get(key);
    const pending = (async () => {
      if (previous) await previous.catch(() => undefined);
      this.known(checkout.repository);
      await this.deps.worktrees.launchIdentity(checkout.repository, checkout.worktree);
      const scan = await this.scanAgents(false);
      if (
        this.enabled[agent] === false ||
        !scan.agents.some((entry) => entry.id === agent && entry.path)
      )
        throw new Error("Agent is unavailable");
      const running = [...this.launched.values()].find(
        (entry) =>
          entry.agent === agent &&
          entry.conversationId === id &&
          !entry.dormant &&
          this.executionOwner.view(entry.id).exitCode === undefined,
      );
      if (running) {
        this.deps.reveal?.(running.id);
        return;
      }
      await this.startExisting(
        checkout.repository,
        checkout.worktree,
        agent,
        confirm,
        undefined,
        undefined,
        false,
        undefined,
        id,
      );
    })();
    this.resumeStarts.set(key, pending);
    try {
      await pending;
    } finally {
      if (this.resumeStarts.get(key) === pending) this.resumeStarts.delete(key);
    }
  }

  private async startExisting(
    repository: string,
    worktree: string,
    run: AgentId,
    confirm: ConfirmWorkspace,
    replacement?: { id: string; conversationId?: string },
    control?: AgentLaunch["control"],
    restoring = false,
    authorityIdentity?: string,
    pastedId?: string,
  ): Promise<string | undefined> {
    return this.withRepository(repository, async () => {
      const tree = (await this.worktrees(repository)).find((item) => item.path === worktree);
      if (!tree) throw new Error("Worktree was removed. Choose another checkout.");
      if (tree.bare || tree.prunable || tree.locked) throw new Error("Worktree is unavailable");
      const key = `${repository}\0${tree.branch ?? ""}`;
      if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
      this.busyWorktrees.add(key);
      try {
        const identity = await this.deps.worktrees.launchIdentity(repository, worktree);
        if (authorityIdentity !== undefined && identity !== authorityIdentity)
          throw new Error("Repository identity changed during restore");
        if (run !== "shell" && !restoring && !(await this.confirmAgentLaunch(worktree, confirm)))
          return;
        if (run !== "shell") {
          const scan = await this.scanAgents(false);
          if (
            builtinAgent(run)?.hookHealth &&
            this.hooksEnabled &&
            this.agentHooks[run] !== false &&
            !this.acknowledged &&
            scan.agents.some(
              (agent) => agent.id === run && agent.hooks && agent.notifierReplacement === true,
            )
          ) {
            if (!(await confirm({ kind: "notifier" }))) return;
            await this.deps.acknowledgeNotifier();
            this.acknowledged = true;
          }
          if (replacement) {
            if (!restoring) this.orchestration.relaunched(replacement.id);
            const old = this.launched.get(replacement.id);
            if (!old || this.executionOwner.view(old.id).exitCode === undefined)
              throw new Error("Session is no longer exited");
            await this.queues.get(old.id);
            if (!old.dormant) await this.deps.terminals.kill(old.id);
            old.dormant = true;
            this.executionOwner.reset(old.id);
            this.deps.verdicts.forget(old.id);
          }
          try {
            return (
              await this.launchAgent(
                {
                  agent: run,
                  repository,
                  worktree,
                  cols: 80,
                  rows: 24,
                  acknowledgeNotifierReplacement: this.acknowledged,
                },
                worktree === repository,
                true,
                identity,
                replacement,
                {
                  ...(pastedId === undefined
                    ? {}
                    : { conversationId: pastedId, pinConversation: true }),
                  ...(control === undefined
                    ? {}
                    : {
                        control,
                        ...("parentId" in control ? { prompt: "Resume your previous task." } : {}),
                      }),
                },
              )
            ).id;
          } catch (error) {
            if (replacement) this.executionOwner.markExited(replacement.id, -1);
            this.deps.onChange?.();
            throw error;
          }
        } else {
          if ((await this.deps.worktrees.launchIdentity(repository, worktree)) !== identity)
            throw new Error("Worktree has changed. Select it and try again.");
          return await this.startShell(
            { repository, worktree, branch: tree.branch },
            replacement?.id,
          );
        }
      } finally {
        this.busyWorktrees.delete(key);
      }
    });
  }

  private orchestrationView(id: string): Pick<WorkspaceTerminal, "orchestration" | "handoff"> {
    const view = this.orchestration.view(id);
    const handoff = this.orchestration.handoffs.latest(id);
    return { ...(view ? { orchestration: view } : {}), ...(handoff ? { handoff } : {}) };
  }

  /**
   * The session menu's Make orchestrator: main swaps the running session's grant, so no
   * relaunch or reconnect is needed. One orchestrator per repository; another active one
   * is revoked once the human accepts the transfer, and its children stay with the human.
   */
  private async makeOrchestrator(id: string, confirm: ConfirmWorkspace): Promise<void> {
    const running = () => {
      const entry = this.launched.get(id);
      if (
        !entry ||
        entry.agent === "shell" ||
        entry.config ||
        this.sessions.isRestoring(id) ||
        this.executionOwner.view(id).exitCode !== undefined
      )
        throw new Error("Only a running agent session can orchestrate");
      const view = this.orchestration.view(id);
      if (view?.role === "child" && !view.takenOver)
        throw new Error("Take over this session first");
      return { entry, agent: entry.agent, active: view?.role === "orchestrator" && view.active };
    };
    const { entry, agent, active } = running();
    if (active) return;
    await this.initializeControl();
    const control = await this.control;
    if (!control) throw new Error("Control service unavailable");
    const identity = await this.deps.worktrees.launchIdentity(entry.repository, entry.repository);
    const current = this.orchestration.active(entry.repository);
    const replaced = current === undefined ? undefined : this.launched.get(current);
    const operationId = randomUUID();
    const action = current === undefined ? "make_orchestrator" : "transfer_orchestrator";
    await this.auditHuman(action, id, current ?? null, "pending_confirmation", operationId);
    const accepted = await confirm({
      kind: "orchestrator",
      subject: `${basename(entry.repository)} · ${entry.branch ?? basename(entry.worktree)}`,
      agent,
      ...(replaced && replaced.agent !== "shell"
        ? {
            replacing: `${AGENTS.find((item) => item.id === replaced.agent)?.name ?? replaced.agent} on ${replaced.branch ?? "its checkout"}`,
          }
        : {}),
    });
    if (!accepted) {
      await this.auditHuman(action, id, current ?? null, "declined", operationId);
      return;
    }
    try {
      // The dialog took time: recheck everything it described.
      running();
      if (this.orchestration.active(entry.repository) !== current)
        throw new Error("The orchestrator changed. Try again.");
      if (current !== undefined) await this.revokeOrchestrator(current);
      const slot = this.orchestration.reserve(entry.repository);
      if ("existing" in slot) throw new Error("The orchestrator changed. Try again.");
      try {
        control.setRole(id, "orchestrator");
        slot.bind(id);
        this.sessions.rememberIdentity(entry.repository, identity);
      } finally {
        slot.release();
      }
      await this.auditHuman(action, id, current ?? null, "succeeded", operationId);
    } catch (error) {
      await this.auditHuman(action, id, current ?? null, "indeterminate", operationId);
      throw error;
    }
  }

  /** Ends orchestration as exit does; the session keeps running as an ordinary agent. */
  private async revokeOrchestrator(id: string): Promise<void> {
    const view = this.orchestration.view(id);
    if (view?.role !== "orchestrator" || !view.active) return;
    const operationId = randomUUID();
    await this.auditHuman("revoke_orchestrator", id, id, "running", operationId);
    try {
      (await this.control)?.setRole(id, "agent");
    } finally {
      this.orchestration.revoke(id);
    }
    await this.auditHuman("revoke_orchestrator", id, id, "succeeded", operationId);
  }

  /** A new branch and worktree for an orchestrator child, under the same branch lock. */
  private async createChildWorktree(
    repository: string,
    branch: string,
  ): Promise<{ path: string; branch: string; identity: string }> {
    return this.withRepository(repository, async () => {
      const key = `${repository}\0${branch}`;
      if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
      this.busyWorktrees.add(key);
      try {
        await this.deps.worktrees.validateBranch(repository, branch);
        try {
          const { path } = await this.deps.worktrees.createWorktree(repository, branch, {
            location: this.location,
            newBranch: true,
          });
          const identity = await this.deps.worktrees.launchIdentity(repository, path);
          return { path, branch, identity };
        } catch (error) {
          // Git may have added the checkout before a later step failed.
          const trees = await this.deps.worktrees.listWorktrees(repository).catch(() => undefined);
          if (!trees || trees.some((tree) => tree.branch === branch)) throw new UncertainEffect();
          throw error;
        } finally {
          this.refresh();
        }
      } finally {
        this.busyWorktrees.delete(key);
      }
    });
  }

  /** An ordinary child with a read-only grant, no bypass defaults and no confirmation prompts. */
  private async launchChild(
    parentId: string,
    repository: string,
    worktree: string,
    created: string,
    agent: AgentId,
    prompt: string | undefined,
  ): Promise<string> {
    return this.withRepository(repository, async () => {
      const tree = (await this.worktrees(repository)).find((item) => item.path === worktree);
      if (!tree || tree.bare || tree.locked || tree.prunable || tree.path === repository)
        throw new Error("Worktree is unavailable");
      const key = `${repository}\0${tree.branch ?? ""}`;
      if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
      this.busyWorktrees.add(key);
      try {
        // Only the checkout the orchestrator created, never a replacement at the same path.
        const identity = await this.deps.worktrees.launchIdentity(repository, worktree);
        if (identity !== created) throw new Error("Worktree has changed");
        const launched = await this.launchAgent(
          {
            agent,
            repository,
            worktree,
            cols: 80,
            rows: 24,
            acknowledgeNotifierReplacement: this.acknowledged,
          },
          false,
          false,
          identity,
          undefined,
          { control: { parentId }, prompt: prompt ?? "Await your assigned task." },
        );
        return launched.id;
      } finally {
        this.busyWorktrees.delete(key);
      }
    });
  }

  subscribeExecution(listener: (event: ExecutionTransition) => void): () => void {
    return this.executionOwner.subscribeExecution(listener);
  }

  /** Evaluations remain ordered across invocations reusing the same terminal ID. */
  private enqueue(id: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        if (this.executionOwner.has(id) && !this.closed) await work();
      })
      .catch((error: unknown) => {
        console.error("Unable to evaluate terminal:", error);
      });
    this.queues.set(id, next);
    void next.then(() => {
      if (this.queues.get(id) === next) this.queues.delete(id);
    });
    return next;
  }

  foreground(id: string, name: string): void {
    this.executionOwner.foreground(id, name);
  }
  shellState(id: string, state: ShellState): void {
    this.executionOwner.shellState(id, state);
  }
  output(id: string): void {
    this.probes?.output(id);
    this.executionOwner.output(id);
  }
  evidence(id: string, evidence: AgentEvidence, initial = false): Promise<void> {
    if (this.probeIds.has(id) || this.launched.get(id)?.probe)
      return this.probes?.quiet(id) ?? Promise.resolve();
    return this.executionOwner.evidence(id, evidence, initial);
  }
  quiet(id: string): Promise<void> {
    if (this.probeIds.has(id) || this.launched.get(id)?.probe)
      return this.probes?.quiet(id) ?? Promise.resolve();
    return this.executionOwner.quiet(id);
  }

  /** Resolve per-launch capabilities and persist validated conversation identity here. */
  hook(signal: HookSignal): Promise<void> {
    const id = this.hookKeys.get(signal.terminalId);
    if (!id) return Promise.resolve();
    this.orchestration.invalidateReply(id);
    const entry = this.launched.get(id);
    if (
      entry &&
      conversationId(signal.conversationId) &&
      entry.conversationId !== signal.conversationId
    ) {
      entry.conversationId = signal.conversationId;
      this.persist();
      this.deps.onChange?.();
    }
    return this.executionOwner.hook(id, signal);
  }

  exited(id: string, code: number): Promise<void> {
    this.revokeConfig(id);
    void this.probes?.exited(id).catch(() => undefined);
    this.agents.release(id);
    this.orchestration.exited(id);
    return this.executionOwner.exited(id, code);
  }

  removed(id: string): void {
    this.probeIds.delete(id);
    this.revokeConfig(id);
    void this.probes?.exited(id).catch(() => undefined);
    this.agents.release(id);
    this.orchestration.exited(id);
    this.orchestration.removed(id);
    this.launched.delete(id);
    this.persist();
    this.executionOwner.removed(id);
    this.refresh();
  }

  input(id: string): void {
    this.probes?.input(id);
    this.executionOwner.input(id);
  }
  feedback(id: string, verdictId: string | null, action: VerdictAction): Promise<void> {
    const token = this.configTokens.get(id);
    if (
      token &&
      verdictId === null &&
      this.probes?.waitingAt(token) !== undefined &&
      this.executionOwner.currentState(id)?.state !== "needs_input"
    ) {
      if (action !== "ignored") this.probes.dismiss(token);
      return Promise.resolve();
    }
    return this.executionOwner.feedback(id, verdictId, action);
  }

  /** Call after terminals have stopped. Revokes every launch and closes the receiver. */
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.launchAbort.abort();
    await (await this.probeHttp?.catch(() => undefined))?.close();
    await this.cleanup.dispose();
    this.executionOwner.disposeSubscriptions();
    this.orchestration.disposeUnreadChildren();
    this.deps.watcher?.dispose();
    this.executionOwner.forgetVerdicts();
    this.agents.dispose();
    await this.deps.forge?.close();
    try {
      await (await this.control?.catch(() => undefined))?.close();
    } finally {
      this.hookKeys.clear();
      const receiver = this.receiver;
      this.receiver = undefined;
      try {
        if (receiver) await (await receiver.catch(() => undefined))?.close();
      } finally {
        await this.sessions.flush();
        await flushV2Health();
      }
    }
  }
}
