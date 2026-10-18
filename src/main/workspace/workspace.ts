import { waitingState } from "./waiting-state";
import { observerHealth } from "../agents/providers/installed-observers";
import { flushV2Health } from "../agents/providers/v2-health";
import type { V2HookRuntime } from "../../shared/v2-hooks";
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
import { createHash } from "node:crypto";
import { AgentExecution } from "../agents/execution";
import type { ExecutionPhase, ExecutionSource, ExecutionTransition } from "../../shared/execution";
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
import { detectAgent, ruleRegion } from "../evaluator/agent-rules";
import type { AgentEvidence } from "../../shared/agent-detection";
import { basename, delimiter } from "node:path";
import type { SidebarCommand, SidebarInventory } from "../../shared/workspace";
import { AgentService } from "../agents/agents";
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
type Terminal = {
  v2Hooks?: V2HookRuntime;
  execution?: AgentExecution;
  completedTurn?: number;
  interrupted?: boolean;
  actionVerdict?: string;
  attentionKey?: string;
  dismissedAttention?: string;
  evidence?: AgentEvidence;
  shellRunning?: boolean;
  foregroundProgram?: string;
  exitCode?: number;
  hook?: HookSignal;
  permissionReply?: boolean;
  permissionProgress?: boolean;
  state: TerminalState | null;
  /** Bumped by replies and dismissals; evaluations that began earlier are discarded. */
  generation: number;
  outputVersion: number;
  inputVersion?: number;
};

export interface WorkspaceDependencies {
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
  private readonly sessions: SessionOwner;
  private readonly cleanup: CleanupOwner;
  private launchSequence = 0;
  private readonly executionListeners = new Set<(event: ExecutionTransition) => void>();
  private readonly launched = new Map<string, WorkspaceTerminal>();
  private readonly terminals = new Map<string, Terminal>();
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
            this.execution(terminalId);
            if (binding.v2?.runtime) this.track(terminalId).v2Hooks = binding.v2.runtime;
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
    const prepareWorktreeRemoval = deps.prepareWorktreeRemoval?.bind(deps);
    this.cleanup = new CleanupOwner({
      worktrees: deps.worktrees,
      inventory: (repository) => this.worktrees(repository),
      known: (repository) => {
        this.known(repository);
      },
      withRepository: (repository, work) => this.withRepository(repository, work),
      withRepositoryRemoval: (repository, work) => this.withRepositoryRemoval(repository, work),
      acquireWorktree: (repository, branch) => {
        const key = `${repository}\0${branch ?? ""}`;
        if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
        this.busyWorktrees.add(key);
      },
      releaseWorktree: (repository, branch) => {
        this.busyWorktrees.delete(`${repository}\0${branch ?? ""}`);
      },
      terminals: () => [...this.launched.values()],
      running: (id) =>
        this.sessions.isRestoring(id) ||
        (!this.launched.get(id)?.dormant && this.terminals.get(id)?.exitCode === undefined),
      exitCode: (id) => this.terminals.get(id)?.exitCode,
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
        this.track(row.id).exitCode = -1;
      },
      failed: (id) => {
        this.track(id).exitCode = -1;
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

  private currentState(id: string): TerminalState | null {
    const terminal = this.terminals.get(id);
    const state = terminal?.state;
    const current = waitingState(
      id,
      terminal?.hook?.action === "needs_input" && state
        ? { ...state, attentionKind: "permission" }
        : (state ?? null),
      terminal?.execution?.snapshot(),
      this.orchestration.waitingOn(id),
    );
    // The orchestrator's own attention (a permission prompt, a question) keeps its
    // reason and verdict; the unread reminder only raises otherwise-quiet states.
    if (current?.state === "needs_input") return current;
    const unreadAt = this.orchestration.unreadChildren.overdue(id);
    if (unreadAt !== undefined)
      return {
        id,
        execution: terminal?.execution?.snapshot(),
        verdictId: null,
        state: "needs_input",
        reason: "Child report unread",
        signal: "orchestration:unread",
        confidence: 1,
        timestamp: unreadAt,
        attentionKind: "unknown",
      };
    return current;
  }

  snapshot(): WorkspaceSnapshot {
    return {
      repositories: this.deps.worktrees.listRepositories(),
      terminals: [...this.launched.values()].map((entry) => ({
        ...entry,
        ...(this.terminals.get(entry.id)?.execution
          ? { execution: this.terminals.get(entry.id)?.execution?.snapshot() }
          : {}),
        ...(this.terminals.get(entry.id)?.exitCode !== undefined
          ? { exitCode: this.terminals.get(entry.id)?.exitCode }
          : {}),
        foregroundProgram:
          this.terminals.get(entry.id)?.exitCode === undefined
            ? (this.terminals.get(entry.id)?.foregroundProgram ?? "")
            : "",
        state: this.currentState(entry.id),
        outputRevision: this.terminals.get(entry.id)?.outputVersion ?? 0,
        inputRevision: this.terminals.get(entry.id)?.inputVersion ?? 0,
        exited:
          !this.sessions.isRestoring(entry.id) &&
          (entry.dormant === true || this.terminals.get(entry.id)?.exitCode !== undefined),
        ...this.orchestrationView(entry.id),
        ...(this.sessions.roleNotRestored(entry.id) ? { roleNotRestored: true } : {}),
        mcpConnection: this.mcpConnections.get(entry.id),
      })),
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

  private async withRepositoryRemoval(
    repository: string,
    work: () => Promise<void>,
  ): Promise<void> {
    if (this.closed) throw new Error("Workspace is closed");
    this.known(repository);
    if (this.removingRepositories.has(repository) || this.repositoryOperations.has(repository))
      throw new Error("Repository is busy. Try again when its current operation finishes.");
    this.removingRepositories.add(repository);
    try {
      await work();
    } finally {
      this.removingRepositories.delete(repository);
    }
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
            if (!agent.path || !provider.model?.health) return agent;
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
    if (!model?.setup) throw new Error("Agent setup is unavailable");
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
        this.terminals.get(entry.id)?.exitCode === undefined,
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
      const tracked = this.track(result.id);
      const execution = this.execution(result.id);
      if (tracked.exitCode !== undefined) execution.transition("exited", "exit");
      else if (tracked.evidence) void this.evidence(result.id, tracked.evidence, true);
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
        const windows = process.platform === "win32";
        const environment = this.shellEnvironment();
        const id = await this.deps.terminals.create({
          command: windows ? "powershell.exe" : process.env["SHELL"] || "/bin/bash",
          args: windows ? ["-NoLogo"] : ["-l"],
          shellIntegration: true,
          env: environment.env,
          cwd: tree.path,
          cols: 80,
          rows: 24,
        });
        this.launched.set(id, {
          id,
          startedAt: this.now(),
          kind: "shell",
          agent: "shell",
          ...(environment.names.length ? { environment: environment.names } : {}),
          repository: request.repository,
          worktree: tree.path,
          branch: tree.branch,
          attention: "evaluator",
          state: null,
        });
        this.track(id);
        this.persist();
        this.refresh();
        return id;
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

  private homeFacts: ReturnType<typeof homeShellFacts> | undefined;
  panelFacts(repository: string, worktree: string) {
    this.known(repository);
    return this.deps.worktrees.panelFacts(repository, worktree);
  }

  /** Shells get the All sessions layer only; `pathFirst` stays ahead of its PATH entries. */
  private shellEnvironment(pathFirst?: string): { env: Record<string, string>; names: string[] } {
    const layers = this.deps.environment?.("shell");
    if (layers) return buildLaunchEnvironment({ layers, base: inheritedEnvironment(), pathFirst });
    return pathFirst
      ? { env: { PATH: `${pathFirst}${delimiter}${process.env["PATH"] ?? ""}` }, names: [] }
      : { env: {}, names: [] };
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

  private async startHomeShell(restoreId?: string): Promise<void> {
    const windows = process.platform === "win32";
    const environment = this.shellEnvironment();
    if (restoreId !== undefined) this.terminals.delete(restoreId);
    const id = await this.deps.terminals.create({
      ...(restoreId === undefined ? {} : { id: restoreId }),
      command: shellPath(),
      args: windows ? ["-NoLogo"] : ["-l"],
      shellIntegration: true,
      env: environment.env,
      cwd: homeDirectory,
      cols: 80,
      rows: 24,
    });
    this.launched.set(id, {
      ...this.replacementVersion(restoreId),
      id,
      kind: "shell",
      agent: "shell",
      home: true,
      ...(environment.names.length ? { environment: environment.names } : {}),
      repository: homeDirectory,
      worktree: homeDirectory,
      branch: null,
      attention: "evaluator",
      state: null,
      startedAt: this.now(),
    });
    this.track(id);
    this.persist();
    this.refresh();
  }

  private configStarting = false;

  /**
   * One config session at a time: while one runs, a second launch starts nothing and the
   * renderer focuses the running session. No worktree is created.
   */
  private async startConfig(
    run: AgentId,
    confirm: ConfirmWorkspace,
    replacement?: { id: string; conversationId?: string },
  ): Promise<void> {
    const config = this.deps.config;
    if (!config) throw new Error("Foom config is unavailable");
    const running = [...this.launched.values()].some(
      (entry) =>
        entry.config && !entry.dormant && this.terminals.get(entry.id)?.exitCode === undefined,
    );
    if (running || this.configStarting) return;
    this.configStarting = true;
    try {
      await config.check();
      if (run === "shell") {
        const environment = this.shellEnvironment(config.cliDirectory);
        if (replacement) this.terminals.delete(replacement.id);
        const id = await this.deps.terminals.create({
          ...(replacement ? { id: replacement.id } : {}),
          command: shellPath(),
          args: process.platform === "win32" ? ["-NoLogo"] : ["-l"],
          shellIntegration: true,
          cwd: config.root,
          cols: 80,
          rows: 24,
          env: environment.env,
        });
        this.launched.set(id, {
          ...this.replacementVersion(replacement?.id),
          id,
          kind: "shell",
          agent: "shell",
          config: true,
          ...(environment.names.length ? { environment: environment.names } : {}),
          repository: config.root,
          worktree: config.root,
          branch: null,
          attention: "evaluator",
          state: null,
          startedAt: this.now(),
        });
        this.track(id);
        this.persist();
        this.refresh();
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
        if (!old || this.terminals.get(old.id)?.exitCode === undefined)
          throw new Error("Session is no longer exited");
        await this.queues.get(old.id);
        if (!old.dormant) await this.deps.terminals.kill(old.id);
        old.dormant = true;
        this.terminals.delete(old.id);
        this.deps.verdicts.forget(old.id);
      }
      const defaultArguments = this.defaultArguments[run] ?? [];
      let result: AgentLaunched;
      try {
        result = await this.agents.launch({
          agent: run,
          repository: config.root,
          worktree: config.root,
          cols: 80,
          rows: 24,
          defaultArguments,
          configCli: config.cliDirectory,
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
        if (replacement) this.track(replacement.id).exitCode = -1;
        this.deps.onChange?.();
        throw error;
      }
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
      const tracked = this.track(result.id);
      const execution = this.execution(result.id);
      if (tracked.exitCode !== undefined) execution.transition("exited", "exit");
      else if (tracked.evidence) void this.evidence(result.id, tracked.evidence, true);
      this.persist();
      this.refresh();
    } finally {
      this.configStarting = false;
    }
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
      if (this.terminals.get(entry.id)?.exitCode === undefined)
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
      const exited = this.terminals.get(command.id)?.exitCode !== undefined;
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
          this.terminals.get(entry.id)?.exitCode === undefined,
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
            if (!old || this.terminals.get(old.id)?.exitCode === undefined)
              throw new Error("Session is no longer exited");
            await this.queues.get(old.id);
            if (!old.dormant) await this.deps.terminals.kill(old.id);
            old.dormant = true;
            this.terminals.delete(old.id);
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
            if (replacement) this.track(replacement.id).exitCode = -1;
            this.deps.onChange?.();
            throw error;
          }
        } else {
          if ((await this.deps.worktrees.launchIdentity(repository, worktree)) !== identity)
            throw new Error("Worktree has changed. Select it and try again.");
          const windows = process.platform === "win32";
          const environment = this.shellEnvironment();
          if (replacement) this.terminals.delete(replacement.id);
          const id = await this.deps.terminals.create({
            ...(replacement ? { id: replacement.id } : {}),
            command: windows ? "powershell.exe" : process.env["SHELL"] || "/bin/bash",
            args: windows ? ["-NoLogo"] : ["-l"],
            shellIntegration: true,
            env: environment.env,
            cwd: worktree,
            cols: 80,
            rows: 24,
          });
          this.launched.set(id, {
            ...this.replacementVersion(replacement?.id),
            id,
            startedAt: this.now(),
            kind: "shell",
            agent: "shell",
            ...(environment.names.length ? { environment: environment.names } : {}),
            repository,
            worktree,
            branch: tree.branch,
            attention: "evaluator",
            state: null,
          });
          this.track(id);
          this.persist();
          this.refresh();
          return id;
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
        this.terminals.get(id)?.exitCode !== undefined
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
    this.executionListeners.add(listener);
    return () => {
      this.executionListeners.delete(listener);
    };
  }

  private execution(id: string): AgentExecution {
    const terminal = this.track(id);
    terminal.execution ??= new AgentExecution(
      id,
      ++this.launchSequence,
      (event) => {
        terminal.generation++;
        this.deps.onExecution?.(event);
        this.refresh();
        const entry = this.launched.get(id);
        if (entry?.kind === "agent" && event.to === "idle")
          this.deps.forge?.recheck(entry.worktree);
        for (const listener of this.executionListeners) listener(event);
      },
      this.now,
    );
    return terminal.execution;
  }

  private transition(id: string, phase: ExecutionPhase, source: ExecutionSource): void {
    const terminal = this.track(id);
    const event = this.execution(id).transition(phase, source, terminal.permissionProgress);
    if (!event) return;
    if (phase !== "blocked") {
      delete terminal.attentionKey;
      delete terminal.dismissedAttention;
    }
    if (phase === "working") {
      delete terminal.hook;
      delete terminal.permissionReply;
      delete terminal.permissionProgress;
      delete terminal.completedTurn;
    }
    if (
      phase === "idle" &&
      event.from === "working" &&
      (source === "hook" || !this.completionHook(id))
    )
      terminal.completedTurn = event.turn;
    if (phase === "idle" && event.from === "working" && source !== "hook")
      terminal.v2Hooks?.idle(event.turn);
    if (phase === "exited" && event.from === "working") terminal.interrupted = true;
  }

  private completionHook(id: string): boolean {
    const entry = this.launched.get(id);
    if (this.track(id).v2Hooks) return this.track(id).v2Hooks?.required() === true;
    return (
      entry?.attention === "hooks" &&
      Boolean(!builtinAgent(entry.agent) || builtinAgent(entry.agent)?.completionHook)
    );
  }

  private track(id: string): Terminal {
    let terminal = this.terminals.get(id);
    if (!terminal) {
      terminal = { state: null, generation: 0, outputVersion: 0 };
      this.terminals.set(id, terminal);
    }
    return terminal;
  }

  /** Evaluations for one terminal run in order, so a slow one can't overwrite a newer one. */
  private enqueue(id: string, work: (terminal: Terminal) => Promise<void>): Promise<void> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const terminal = this.terminals.get(id);
        if (terminal && !this.closed) await work(terminal);
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

  private publish(id: string, terminal: Terminal, state: Omit<TerminalState, "id" | "timestamp">) {
    const phase = terminal.execution?.snapshot().phase;
    const dismissed =
      terminal.dismissedAttention !== undefined &&
      terminal.dismissedAttention === terminal.attentionKey;
    const resolved =
      phase === "blocked" && dismissed
        ? "quiet_ok"
        : phase === "working" && state.state !== "needs_input"
          ? "working"
          : phase === "blocked" && state.signal !== "user:dismissed"
            ? "needs_input"
            : (phase === "idle" || phase === "starting") && state.state === "working"
              ? "quiet_ok"
              : state.state;
    this.orchestration.invalidateReply(id);
    terminal.state = {
      id,
      ...state,
      ...(terminal.execution ? { execution: terminal.execution.snapshot() } : {}),
      state: resolved,
      ...(resolved === "needs_input"
        ? {
            attentionKind:
              terminal.hook?.action === "needs_input"
                ? "permission"
                : (state.attentionKind ?? "unknown"),
          }
        : {}),
      outputRevision: terminal.outputVersion,
      inputRevision: terminal.inputVersion ?? 0,
      timestamp: this.now(),
    };
    this.orchestration.childEvents.publish();
    this.deps.onState(this.currentState(id) ?? terminal.state);
  }

  private async evaluate(
    id: string,
    terminal: Terminal,
    generation?: number,
    outputVersion = terminal.outputVersion,
  ): Promise<void> {
    const inputVersion = terminal.inputVersion ?? 0;
    // A reply or dismissal since this evaluation began makes its evidence stale.
    const stale = () =>
      this.closed ||
      this.terminals.get(id) !== terminal ||
      (terminal.exitCode === undefined && (terminal.inputVersion ?? 0) !== inputVersion) ||
      (generation !== undefined && generation !== terminal.generation) ||
      (terminal.exitCode === undefined &&
        (!terminal.hook || terminal.permissionProgress) &&
        outputVersion !== terminal.outputVersion);
    if (stale()) return;
    let tail: string[] = [];
    try {
      tail = await this.deps.terminals.tail(id, 40);
    } catch {
      // A failed host has no screen. Exit codes and hooks still decide.
    }
    terminal.v2Hooks?.review(tail);
    let record = await this.deps.verdicts.classify({
      terminalId: id,
      tail,
      ...this.agentInput(id, terminal),
      ...(terminal.hook && !terminal.permissionProgress ? { hook: terminal.hook } : {}),
      ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
    });
    if (stale()) return;
    const execution = terminal.execution?.snapshot();
    const agentInput = this.agentInput(id, terminal);
    const detected =
      agentInput.agent && agentInput.evidence
        ? detectAgent(agentInput.agent, agentInput.evidence, tail)
        : undefined;
    if (execution && terminal.exitCode === undefined) {
      if (record.verdict.state === "needs_input") {
        // Compare the attention evidence, not verdict IDs or animated title frames.
        const attentionEvidence =
          terminal.hook && !terminal.permissionProgress
            ? ""
            : record.verdict.signal.startsWith("pattern:")
              ? tail.findLast((line) => line.trim().length > 0)?.trim()
              : detected?.state === "blocked" && detected.region !== "title" && agentInput.evidence
                ? ruleRegion(detected, agentInput.evidence, tail)
                : tail;
        terminal.attentionKey = createHash("sha256")
          .update(JSON.stringify([record.verdict.signal, attentionEvidence]))
          .digest("hex");
        if (terminal.dismissedAttention !== terminal.attentionKey)
          delete terminal.dismissedAttention;
        this.transition(
          id,
          "blocked",
          terminal.hook && !terminal.permissionProgress ? "hook" : "screen",
        );
      } else if (
        execution.phase === "blocked" &&
        record.verdict.state === "working" &&
        detected?.state === "working" &&
        record.verdict.signal === `rules:${agentInput.agent ?? ""}:${detected.id}`
      ) {
        this.transition(id, "working", "title");
      } else if (
        execution.phase === "idle" &&
        terminal.completedTurn === execution.turn &&
        record.verdict.state === "working"
      ) {
        record = {
          ...record,
          verdict: {
            state: "done",
            reason: "Agent turn completed",
            signal: "execution:completed",
            confidence: 0.95,
          },
        };
      } else if (
        execution.phase === "idle" &&
        this.completionHook(id) &&
        terminal.completedTurn !== execution.turn &&
        record.verdict.state !== "failed"
      ) {
        record = {
          ...record,
          verdict: {
            state: "quiet_ok",
            reason: "Turn ended without a completion hook",
            signal: "execution:idle",
            confidence: 0.95,
          },
        };
      }
    }
    if (terminal.interrupted)
      record = {
        ...record,
        verdict: {
          state: "failed",
          reason: "Agent exited during a turn",
          signal: "execution:interrupted",
          confidence: 1,
        },
      };
    // A blocker transition above is part of this evaluation, not stale evidence.
    generation = terminal.generation;
    if (
      terminal.state?.verdictId &&
      terminal.state.state === record.verdict.state &&
      terminal.state.signal === record.verdict.signal &&
      terminal.state.outputRevision === terminal.outputVersion &&
      terminal.state.inputRevision === (terminal.inputVersion ?? 0) &&
      terminal.state.execution?.revision === terminal.execution?.snapshot().revision
    )
      return;
    let verdictId: string | null = record.id;
    try {
      await this.deps.verdicts.commit(record);
    } catch (error) {
      // The state still goes out; an unstored verdict just has no feedback target.
      console.error("Unable to record verdict:", error);
      verdictId = null;
    }
    if (stale()) return;
    this.publish(id, terminal, { verdictId, ...record.verdict });
  }

  /** Validated host metadata, excluded from persisted sessions. */
  foreground(id: string, name: string): void {
    const terminal = this.track(id);
    if (terminal.exitCode !== undefined || terminal.foregroundProgram === name) return;
    terminal.foregroundProgram = name;
    this.refresh();
  }

  /** Invocation-scoped shell markers, never prompt text guessed from screen contents. */
  shellState(id: string, state: ShellState): void {
    const terminal = this.track(id);
    if (terminal.exitCode !== undefined) return;
    const wasRunning = terminal.shellRunning;
    terminal.shellRunning = state.phase === "running";
    terminal.generation += 1;
    if (terminal.hook) return;
    if (state.phase === "prompt" && wasRunning === false) return;
    this.publish(id, terminal, {
      verdictId: null,
      state:
        state.phase === "running"
          ? "working"
          : wasRunning === undefined
            ? "quiet_ok"
            : state.exitCode === 0
              ? "done"
              : "failed",
      reason:
        state.phase === "running"
          ? "Command is running"
          : wasRunning === undefined
            ? "Shell is ready"
            : state.exitCode === 0
              ? "Command completed"
              : `Command exited with status ${String(state.exitCode)}`,
      signal: "process:shell",
      confidence: 1,
    });
  }

  /** Output invalidates screen evidence without dismissing authoritative hooks. */
  output(id: string): void {
    const terminal = this.track(id);
    terminal.outputVersion += 1;
    this.orchestration.invalidateReply(id);
    if (
      terminal.execution !== undefined ||
      this.launched.get(id)?.kind === "agent" ||
      terminal.exitCode !== undefined ||
      terminal.hook ||
      terminal.shellRunning === false ||
      terminal.state?.state === "working"
    )
      return;
    this.publish(id, terminal, {
      verdictId: null,
      state: "working",
      reason: "Terminal output resumed",
      signal: "process:output",
      confidence: 1,
    });
  }

  private agentInput(id: string, terminal: Terminal): Pick<EvaluationInput, "agent" | "evidence"> {
    const agent = this.launched.get(id)?.agent;
    return agent && agent !== "shell"
      ? { agent, evidence: terminal.evidence ?? { title: "", progress: null } }
      : {};
  }

  /** Metadata is local evidence; parsing has drained before the host publishes it. */
  evidence(id: string, evidence: AgentEvidence, initial = false): Promise<void> {
    const terminal = this.track(id);
    const previousEvidence = terminal.evidence ?? { title: "", progress: null };
    terminal.evidence = evidence;
    const { agent } = this.agentInput(id, terminal);
    // Unknown metadata and progress-only updates are not quiet signals. Keep them
    // for the next real quiet event rather than submitting an actively changing tail.
    if ((!initial && previousEvidence.title === evidence.title) || !agent) return Promise.resolve();
    const previous = detectAgent(agent, previousEvidence, []);
    const next = detectAgent(agent, evidence, []);
    if (terminal.permissionReply && next?.state === "working") terminal.permissionProgress = true;
    const resuming =
      terminal.execution?.snapshot().phase === "blocked" && next?.state === "working";
    if (
      !next ||
      (!initial && !resuming && previous?.id === next.id && previous.state === next.state)
    )
      return Promise.resolve();
    // A spinner must not override a prompt still present on the screen.
    if (next.state !== "unknown" && !resuming) this.transition(id, next.state, "title");
    return this.quiet(id);
  }

  /** Output went quiet. Live terminals only; an exit verdict is final. */
  quiet(id: string): Promise<void> {
    const { generation, outputVersion } = this.track(id);
    return this.enqueue(id, async (terminal) => {
      if (terminal.exitCode === undefined && terminal.shellRunning !== false)
        await this.evaluate(id, terminal, generation, outputVersion);
    });
  }

  /** Hook signals carry a per-launch key; map it back to the terminal before use. */
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
    if (this.track(id).exitCode !== undefined) return Promise.resolve();
    const health = this.track(id);
    const runtime = health.v2Hooks;
    if (
      runtime &&
      signal.recoverTurn === true &&
      signal.action === "classify" &&
      this.execution(id).snapshot().phase !== "working"
    )
      this.transition(id, "working", "hook");
    if (
      runtime &&
      signal.action !== "working" &&
      !runtime.accept(signal, this.execution(id).snapshot().turn)
    )
      return Promise.resolve();
    if (signal.action === "ready" && signal.signal.startsWith("plugin:")) {
      if (runtime && health.hook?.action === "needs_input") return Promise.resolve();
      const wasWorking = this.execution(id).snapshot().phase === "working";
      this.transition(id, "idle", "hook");
      if (signal.endsTurn === false && wasWorking) delete health.completedTurn;
      return Promise.resolve();
    }
    if (signal.action === "working") {
      this.track(id).generation++;
      this.transition(id, "working", "hook");
      runtime?.accept(signal, this.execution(id).snapshot().turn);
      return Promise.resolve();
    }
    // A fully idle Stop proves a turn ran even when its background start report
    // was overtaken. Recover the turn identity before classifying completion.
    if (
      (signal.signal === "agy:Stop" || signal.recoverTurn === true) &&
      signal.action === "classify" &&
      signal.terminationReason === "model_stop" &&
      signal.fullyIdle === true &&
      this.execution(id).snapshot().phase !== "working"
    )
      this.transition(id, "working", "hook");
    if (signal.action === "failed") {
      this.track(id).hook = { terminalId: id, action: signal.action, signal: signal.signal };
      if (signal.endsTurn !== false) this.transition(id, "idle", "hook");
    } else if (signal.action === "needs_input") {
      delete this.track(id).permissionReply;
      delete this.track(id).permissionProgress;
      delete this.track(id).dismissedAttention;
      this.track(id).hook = { terminalId: id, action: signal.action, signal: signal.signal };
      this.transition(id, "blocked", "hook");
    } else if (signal.endsTurn !== false) {
      const terminal = this.track(id);
      const turn = terminal.execution?.snapshot().turn;
      if (turn && (signal.signal.startsWith("plugin:") || signal.signal === "agy:Stop"))
        terminal.completedTurn = turn;
      this.transition(id, "idle", "hook");
    }
    const { generation } = this.track(id);
    return this.enqueue(id, async (terminal) => {
      // A newer lifecycle transition invalidates this queued classification.
      if (terminal.exitCode !== undefined || terminal.generation !== generation) return;
      // Explicit permission persists until supported execution evidence resumes work.
      if (signal.action === "needs_input")
        terminal.hook = { terminalId: id, action: signal.action, signal: signal.signal };
      await this.evaluate(id, terminal, generation);
    });
  }

  /** Exit verdicts ignore replies: the process is gone, so its exit always stands. */
  exited(id: string, code: number): Promise<void> {
    this.agents.release(id);
    this.orchestration.exited(id);
    const current = this.track(id);
    if (current.execution) this.transition(id, "exited", "exit");
    return this.enqueue(id, async (terminal) => {
      if (terminal.exitCode !== undefined) return;
      terminal.exitCode = code;
      const entry = this.launched.get(id);
      if (entry?.kind === "agent") this.deps.forge?.recheck(entry.worktree);
      this.persist();
      delete terminal.hook;
      await this.evaluate(id, terminal);
    });
  }

  /** The terminal was killed and removed from the board. */
  removed(id: string): void {
    this.agents.release(id);
    this.orchestration.exited(id);
    this.orchestration.removed(id);
    this.launched.delete(id);
    this.persist();
    this.terminals.delete(id);
    this.deps.verdicts.forget(id);
    this.refresh();
  }

  /**
   * The user typed into the terminal (terminal-generated reports are filtered out
   * before this). Record reply feedback once. For agents, lifecycle evidence alone
   * establishes resumed execution; shells retain their reply behavior.
   */
  input(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    terminal.inputVersion = (terminal.inputVersion ?? 0) + 1;
    this.orchestration.invalidateReply(id);
    if (terminal.hook?.action === "needs_input") {
      terminal.permissionReply = true;
    }
    if (!terminal.execution) {
      terminal.generation += 1;
      delete terminal.hook;
    }
    const state = terminal.state;
    if (state?.state !== "needs_input") return;
    if (!terminal.execution) this.clear(id, terminal, "replied");
    if (state.verdictId && state.verdictId !== terminal.actionVerdict) {
      terminal.actionVerdict = state.verdictId;
      void this.deps.verdicts
        .recordAction(id, state.verdictId, "replied")
        .catch((error: unknown) => {
          console.error("Unable to record reply:", error);
        });
    }
  }

  /** A null `verdictId` refers to a current verdict that couldn't be stored. */
  async feedback(id: string, verdictId: string | null, action: VerdictAction): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error("Unknown terminal");
    this.orchestration.invalidateReply(id);
    const current = () => terminal.state !== null && terminal.state.verdictId === verdictId;
    if (verdictId !== null) {
      const previousAction = terminal.actionVerdict;
      terminal.actionVerdict = verdictId;
      try {
        await this.deps.verdicts.recordAction(id, verdictId, action);
      } catch (error) {
        if (terminal.actionVerdict === verdictId) {
          if (previousAction === undefined) delete terminal.actionVerdict;
          else terminal.actionVerdict = previousAction;
        }
        throw error;
      }
    } else if (!current() || terminal.state?.signal.startsWith("user:"))
      throw new Error("Invalid verdict feedback");
    // A newer verdict may have arrived while the action was being recorded.
    if (action === "ignored" || !current()) return;
    terminal.generation += 1;
    if (!terminal.execution) delete terminal.hook;
    if (action === "dismissed" && terminal.attentionKey !== undefined)
      terminal.dismissedAttention = terminal.attentionKey;
    this.clear(id, terminal, action);
  }

  private clear(id: string, terminal: Terminal, action: "replied" | "dismissed"): void {
    this.publish(id, terminal, {
      verdictId: null,
      state: action === "replied" ? "working" : "quiet_ok",
      reason: action === "replied" ? "You replied" : "Not attention",
      signal: action === "replied" ? "user:reply" : "user:dismissed",
      confidence: 1,
    });
  }

  /** Call after terminals have stopped. Revokes every launch and closes the receiver. */
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.launchAbort.abort();
    await this.cleanup.dispose();
    this.executionListeners.clear();
    this.orchestration.disposeUnreadChildren();
    this.deps.watcher?.dispose();
    for (const id of this.terminals.keys()) this.deps.verdicts.forget(id);
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
