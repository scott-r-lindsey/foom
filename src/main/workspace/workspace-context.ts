import type { StoredSession } from "./session-restore.d";
import {
  discoverRemoteSessions,
  reattachRemoteSession,
  RemoteSessionExit,
} from "./remote-session-restore";
import type { OrchestrationHost } from "../control/orchestration.d";
import { RemovalError } from "./worktree-outcome";
import { workspaceFeatureWiring } from "./workspace-feature-wiring";
import { workspaceOrchestrationHost } from "./workspace-orchestration-host";
import * as orchestrationCommands from "./orchestration-commands";

import type { ActionLogPage } from "../../shared/action-log";
import type { AgentHooks, AgentId, AgentLaunch } from "../../shared/agents";
import type { ConfirmWorkspace } from "../../shared/confirmation";
import type { ExecutionTransition } from "../../shared/execution";
import type { Settings } from "../../shared/setup";
import type { McpConnection, WorkspaceSnapshot, WorkspaceTerminal } from "../../shared/workspace";
import type { BranchInventory, Repository, Worktree } from "../../shared/worktrees";
import { AgentService } from "../agents/agents";
import { AgyPlugin } from "../agents/agy-plugin";
import { EMPTY_AGENT_ARGUMENTS } from "../agents/default-arguments";
import type { ProbeHttp } from "../agents/probe-http";
import type { AgentProbes } from "../agents/probes";
import { prepareHookLaunch } from "../agents/providers/hook-launch";
import { flushV2Health } from "../agents/providers/v2-health";
import { Orchestration } from "../control/orchestration";
import type { ControlRuntime } from "../control/runtime";
import type { ControlLaunch } from "../control/types";
import { CleanupOwner } from "./cleanup-owner";
import { ExecutionOwner } from "./execution-owner";
import type { homeShellFacts } from "./home-shell";
import { SessionLifecycle } from "./session-lifecycle";
import { SessionOwner } from "./session-owner";
import * as sidebarCommands from "./sidebar-commands";
import type { Agents, WorkspaceDependencies, WorkspaceMethods } from "./workspace-types";
import * as worktreeLaunch from "./worktree-launch";

/**
 * Main-process integration: launches agents into managed worktrees, turns quiet events,
 * exits and hook signals into verdicts, and reports state. Terminal IDs are the only
 * identifiers crossing into evaluation; agent text never does.
 */
export class WorkspaceContext {
  private readonly features = workspaceFeatureWiring(this);
  /** Repository orchestrators and their children; the control service delegates here. */
  readonly orchestration: Orchestration;
  private readonly orchestrationHost: OrchestrationHost;
  readonly agents: Agents;
  probes: AgentProbes | undefined;
  readonly probeIds = new Set<string>();
  probeHttp: Promise<ProbeHttp> | undefined;
  readonly configTokens = new Map<string, string>();
  readonly sessions: SessionOwner;
  readonly cleanup: CleanupOwner;
  readonly launched = new Map<string, WorkspaceTerminal>();
  readonly executionOwner: ExecutionOwner;
  readonly lifecycle: SessionLifecycle;
  private sidebarRead: ReturnType<WorkspaceMethods["sidebarInventory"]> | undefined;
  readonly agyPlugin = new AgyPlugin();
  readonly hookKeys = new Map<string, string>();
  readonly queues = new Map<string, Promise<void>>();
  control:
    | Promise<
        Pick<ControlRuntime, "prepare" | "close" | "setRole"> &
          Partial<Pick<ControlRuntime, "audit" | "takeOver">>
      >
    | undefined;
  receiver: ReturnType<WorkspaceDependencies["receiver"]> | undefined;
  scanned: ReturnType<Agents["scan"]> | undefined;
  closed = false;
  readonly launchAbort = new AbortController();
  location: "root" | "adjacent" = "root";
  hooksEnabled = true;
  agentHooks: Readonly<Record<string, boolean>> = {};
  concurrentChildren = 4;
  showNewChildren = true;
  defaultArguments = EMPTY_AGENT_ARGUMENTS;
  readonly resumeStarts = new Map<string, Promise<void>>();
  readonly busySessions = new Set<string>();
  readonly busyWorktrees = new Set<string>();
  readonly repositoryOperations = new Map<string, Set<symbol>>();
  readonly removingRepositories = new Set<string>();
  enabled: Readonly<Record<AgentId, boolean>> = { claude: true, codex: true, agy: true };
  readonly now: () => number;

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

  auditHuman: WorkspaceMethods["auditHuman"] = orchestrationCommands.auditHuman.bind(
    this.features.orchestrationCommands,
  );

  constructor(readonly deps: WorkspaceDependencies) {
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
    this.orchestrationHost = workspaceOrchestrationHost(this.features.orchestrationHost);
    this.orchestration = new Orchestration(
      this.orchestrationHost,
      this.now,
      () => this.concurrentChildren,
    );
    this.lifecycle = new SessionLifecycle({
      release: (id) => {
        this.revokeConfig(id);
        void this.probes?.exited(id).catch(() => undefined);
        this.agents.release(id);
      },
      observed: (id) => {
        this.orchestration.exited(id);
      },
      evaluate: (id, code) => this.executionOwner.exited(id, code),
      inventorySettled: () => {
        this.persist();
      },
    });
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
        this.lifecycle.inventorySettled(id);
      },
      reset: (id) => {
        this.lifecycle.reset(id);
      },
      publishChildEvents: () => {
        this.orchestration.childEvents.publish();
      },
      waitingOn: (id) => this.orchestration.waitingOn(id),
      reviewReason: (id) => this.orchestration.reviewAttentionReason(id),
      unreadAt: (id) =>
        this.orchestration.reviewUnreadAt(id) ?? this.orchestration.unreadChildren.overdue(id),
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
      terminals: () => [...this.launched.values()],
      running: (id) =>
        this.sessions.isRestoring(id) ||
        (!this.launched.get(id)?.dormant && this.executionOwner.view(id).exitCode === undefined),
      exitCode: (id) => this.executionOwner.view(id).exitCode,
      stop: async (id) => {
        await deps.terminals.stop(id);
      },
      exited: (id, code) => this.exited(id, code),
      kill: (id, host) =>
        host === undefined ? deps.terminals.kill(id) : deps.terminals.kill(id, host),
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
    const registeredHosts = deps.hosts;
    this.sessions = new SessionOwner({
      ...(registeredHosts
        ? {
            discover: () => discoverRemoteSessions(registeredHosts),
            rememberRemote: (entry: StoredSession) => {
              if (entry.remoteCheckout && entry.placement?.kind === "remote")
                registeredHosts.rememberPlacement?.(
                  entry.repository,
                  entry.worktree,
                  entry.placement.host,
                  entry.remoteCheckout,
                );
            },
          }
        : {}),
      ...(deps.sessions ? { store: deps.sessions } : {}),
      ...(deps.config ? { configRoot: deps.config.root } : {}),
      orchestration: this.orchestration,
      terminals: () => this.snapshot().terminals,
      terminal: (id) => this.launched.get(id),
      restoreRow: (row) => {
        this.launched.set(row.id, row);
        this.executionOwner.markExited(row.id, -1);
      },
      failed: (id, error) => {
        this.executionOwner.markExited(id, error instanceof RemoteSessionExit ? error.code : -1);
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
        if (entry.remote && registeredHosts) {
          this.executionOwner.reset(entry.id);
          const result = await reattachRemoteSession(
            entry,
            registeredHosts,
            deps.terminals,
            (request) => this.agents.launch(request),
            control,
            control && "parentId" in control
              ? this.orchestration.remoteParentGuard(control.parentId)
              : undefined,
          );
          const row = {
            ...entry,
            ...result,
            ...this.replacementVersion(entry.id),
            dormant: false,
            exited: false,
            state: null,
          };
          delete row.running;
          delete row.recovered;
          delete row.remoteCheckout;
          delete row.parentId;
          delete row.orchestrator;
          this.launched.set(entry.id, row);
          this.executionOwner.launched(entry.id);
          if (entry.recovered) deps.placeChild?.(entry.id, entry.id);
          this.refresh();
          return entry.id;
        }
        if (entry.home) {
          await this.startHomeShell(entry.id);
          return undefined;
        }
        if (entry.config) {
          await this.startConfig(entry.agent, replacement);
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
          {
            bind: (key, id, runtime) => {
              this.hookKeys.set(key, id);
              this.executionOwner.attachHooks(id, runtime);
            },
            signal: (signal) => this.hook(signal),
            revoke: (key) => {
              this.hookKeys.delete(key);
            },
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
          | "agentArguments"
          | "agentBypassIdentities"
          | "agentHooks"
          | "showNewChildren"
          | "closeFinishedAgents"
          | "restoreSessions"
          | "concurrentChildren"
          | "unreadChildMinutes"
          | "autoRemoveMergedWorktrees"
          | "showPullRequests"
        >
      >,
  ): void {
    this.sidebarRead = undefined;
    this.deps.forge?.setEnabled(settings.showPullRequests === true);
    this.sessions.configure(settings.restoreSessions ?? true);
    this.concurrentChildren = settings.concurrentChildren ?? 4;
    this.showNewChildren = settings.showNewChildren ?? true;
    this.orchestration.configureCloseFinished(settings.closeFinishedAgents ?? true);
    const reminderChanged = this.orchestration.unreadChildren.configure(
      settings.unreadChildMinutes ?? 5,
    );
    this.cleanup.configure(settings.autoRemoveMergedWorktrees ?? false);
    this.agents.setBypassIdentities(settings.agentBypassIdentities);
    if (settings.agentHooks) this.agents.setHooksEnabled(settings.hooks, settings.agentHooks);
    else this.agents.setHooksEnabled(settings.hooks);
    this.agentHooks = settings.agentHooks ?? {};
    this.hooksEnabled = settings.hooks;
    this.defaultArguments = settings.agentArguments ?? EMPTY_AGENT_ARGUMENTS;
    if (JSON.stringify(this.enabled) !== JSON.stringify(settings.agents)) this.scanned = undefined;
    this.enabled = settings.agents;
    this.location = settings.worktreeLocation ?? "root";
    if (reminderChanged) this.refresh();
  }

  async restore(): Promise<void> {
    await this.sessions.restore();
  }

  ownsSession(id: string): boolean {
    return this.launched.has(id);
  }

  persist(): void {
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

  readonly mcpConnections = new Map<string, McpConnection>();

  mcpConnectionChanged(id: string, state: McpConnection | undefined): void {
    if (state === undefined) this.mcpConnections.delete(id);
    else this.mcpConnections.set(id, state);
    this.refresh();
  }

  probeState: WorkspaceMethods["probeState"] = sidebarCommands.probeState.bind(
    this.features.configLaunch,
  );
  snapshot(): WorkspaceSnapshot {
    return {
      repositories: this.deps.worktrees.listRepositories(),
      terminals: [...this.launched.values()].map((entry) => {
        const view = this.executionOwner.view(entry.id);
        const exit = this.lifecycle.exit(entry.id);
        // Dormant restored/failed launches have no host observation in this process.
        const exitCode = exit && exit.phase !== "host-observed" ? exit.code : view.exitCode;
        return {
          ...entry,
          ...(view.execution ? { execution: view.execution } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          foregroundProgram: exitCode === undefined ? (view.foregroundProgram ?? "") : "",
          state: this.probeState(entry.id, this.executionOwner.currentState(entry.id)),
          outputRevision: view.outputRevision,
          inputRevision: view.inputRevision,
          exited:
            !this.sessions.isRestoring(entry.id) &&
            (entry.dormant === true || exitCode !== undefined),
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
    this.orchestration.readReviews(id);
    this.orchestration.syncUnreadChildEvents();
    if (this.orchestration.unreadChildren.read(id)) this.refresh();
  }

  refresh(): void {
    if (this.closed) return;
    this.sidebarRead = undefined;
    this.orchestration.syncUnreadChildEvents();
    this.orchestration.childEvents.publish();
    this.deps.watcher?.sync(this.deps.worktrees.listRepositories());
    this.deps.onChange?.();
  }

  known(repository: string): void {
    if (!this.deps.worktrees.listRepositories().some((entry) => entry.path === repository))
      throw new Error("Repository has not been added");
  }

  /** Reserve registration before any async work; independent launches can still overlap. */
  async withRepository<T>(repository: string, work: () => Promise<T>): Promise<T> {
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

  reserveRepositoryRemoval(repository: string, validate: () => void): () => void {
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
    const local = await this.deps.worktrees.listWorktrees(repository);
    const discovered = await this.deps.hosts?.worktrees?.(repository);
    const remote = discovered ?? [
      ...new Map(
        [...this.launched.values()]
          .filter(
            (row) =>
              row.repository === repository &&
              row.placement?.kind === "remote" &&
              row.worktree.startsWith("/foom-remote/"),
          )
          .map((row) => [
            row.worktree,
            {
              path: row.worktree,
              branch: row.branch,
              head: null,
              bare: false,
              locked: false,
              prunable: false,
              managed: false,
            },
          ]),
      ).values(),
    ];
    return [...local, ...remote];
  }

  async branches(repository: string): Promise<BranchInventory> {
    this.known(repository);
    return this.deps.worktrees.branches(repository);
  }

  /** Create only: nothing launches. Without a location, the configured one applies. */
  createWorktree: WorkspaceMethods["createWorktree"] = sidebarCommands.createWorktree.bind(
    this.features.repositoryOperations,
  );

  addWorktree: WorkspaceMethods["addWorktree"] = sidebarCommands.addWorktree.bind(
    this.features.repositoryOperations,
  );

  scannedProviders = -1;
  scanAgents: WorkspaceMethods["scanAgents"] = worktreeLaunch.scanAgents.bind(
    this.features.agentSetup,
  );
  changeAgentSetup: WorkspaceMethods["changeAgentSetup"] = worktreeLaunch.changeAgentSetup.bind(
    this.features.agentSetup,
  );

  changeAgyPlugin: WorkspaceMethods["changeAgyPlugin"] = worktreeLaunch.changeAgyPlugin.bind(
    this.features.agentSetup,
  );

  confirmAgentLaunch: WorkspaceMethods["confirmAgentLaunch"] =
    worktreeLaunch.confirmAgentLaunch.bind(this.features.worktreeLaunch);

  launch: WorkspaceMethods["launch"] = worktreeLaunch.launch.bind(this.features.worktreeLaunch);

  launchAgent: WorkspaceMethods["launchAgent"] = worktreeLaunch.launchAgent.bind(
    this.features.worktreeLaunch,
  );

  startWorktree: WorkspaceMethods["startWorktree"] = worktreeLaunch.startWorktree.bind(
    this.features.worktreeLaunch,
  );

  removeWorktree: WorkspaceMethods["removeWorktree"] = sidebarCommands.removeWorktree.bind(
    this.features.repositoryOperations,
  );

  /** Shared launch/removal reservation; cleanup owns the removal sequence. */
  async removeTree(
    repository: string,
    worktree: string,
    branch: string | null,
    confirm: (branch: string, changes: string, automatic?: boolean) => Promise<boolean>,
    revalidate?: () => void | Promise<void>,
    retainBranchLock?: (release: () => void) => void,
    autoApprove?: () => Promise<boolean>,
    readSnapshot?: () => Promise<string>,
  ): Promise<boolean> {
    if (worktree.startsWith("/foom-remote/")) {
      const tree = this.deps.hosts?.placement?.(worktree);
      if (!tree || tree.localRepository !== repository)
        throw new Error("Remote worktree unavailable");
      return this.orchestrationHost.remove(
        repository,
        worktree,
        tree.identity,
        (branch, changes) =>
          this.deps.dialog?.(
            {
              title: "Remove remote worktree?",
              accept: changes ? "Discard changes and remove" : "Remove worktree",
              glyph: "trash",
              subject: `${tree.host}:${tree.path}`,
              removal: {
                group: `remote-human-${worktree}`,
                item: { id: worktree, branch, path: `${tree.host}:${tree.path}`, changes },
              },
            },
            this.launchAbort.signal,
          ) ?? Promise.resolve(false),
        () => {
          if (this.closed) throw new Error("Workspace closed");
          this.known(repository);
        },
      );
    }
    const key = `${repository}\0${branch ?? ""}`;
    if (this.busyWorktrees.has(key)) throw new RemovalError("busy", "This worktree is busy");
    this.busyWorktrees.add(key);
    // This capability belongs to this acquisition, not to whichever operation
    // happens to own the same branch key when a delayed release runs.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.busyWorktrees.delete(key);
    };
    let removed = false;
    try {
      removed = await this.cleanup.removeReservedTree(
        repository,
        worktree,
        branch,
        confirm,
        revalidate,
        autoApprove,
        readSnapshot,
      );
      return removed;
    } finally {
      if (retainBranchLock && removed) retainBranchLock(release);
      else release();
    }
  }

  homeFacts: ReturnType<typeof homeShellFacts> | undefined;
  panelFacts(repository: string, worktree: string) {
    this.known(repository);
    return this.deps.worktrees.panelFacts(repository, worktree);
  }

  /** Shells get the All sessions layer only; `pathFirst` stays ahead of its PATH entries. */
  shellEnvironment: WorkspaceMethods["shellEnvironment"] = worktreeLaunch.shellEnvironment.bind(
    this.features.worktreeLaunch,
  );

  /**
   * Reusing a terminal ID resets the renderer's row and advances its launch version.
   * Advance main's too, or the renderer treats every later snapshot of the row as stale.
   */
  replacementVersion(id: string | undefined): Pick<WorkspaceTerminal, "launchVersion"> {
    return id === undefined
      ? {}
      : { launchVersion: (this.launched.get(id)?.launchVersion ?? 0) + 1 };
  }

  /** Shared shell launch path; callers validate their location before spawning. */
  startShell: WorkspaceMethods["startShell"] = worktreeLaunch.startShell.bind(
    this.features.worktreeLaunch,
  );

  startHomeShell: WorkspaceMethods["startHomeShell"] = worktreeLaunch.startHomeShell.bind(
    this.features.worktreeLaunch,
  );

  revokeConfig: WorkspaceMethods["revokeConfig"] = sidebarCommands.revokeConfig.bind(
    this.features.configLaunch,
  );
  bindConfig(id: string, token: string): void {
    this.configTokens.set(id, token);
    if (this.lifecycle.exit(id) || this.executionOwner.view(id).exitCode !== undefined)
      this.revokeConfig(id);
  }
  ensureProbeOpen: WorkspaceMethods["ensureProbeOpen"] = sidebarCommands.ensureProbeOpen.bind(
    this.features.configLaunch,
  );
  configCredential: WorkspaceMethods["configCredential"] = sidebarCommands.configCredential.bind(
    this.features.configLaunch,
  );

  /** Config sessions have no worktree or repository grants. */
  startConfig: WorkspaceMethods["startConfig"] = sidebarCommands.startConfig.bind(
    this.features.configLaunch,
  );

  sidebarInventory: WorkspaceMethods["sidebarInventory"] = () => {
    if (this.sidebarRead) return this.sidebarRead;
    // Several windows and preview placement can request the same expensive inventory.
    // Share only work in flight; refresh/configure invalidate it for later callers.
    const pending = sidebarCommands.sidebarInventory.call(this.features.sidebarCommands);
    this.sidebarRead = pending;
    const clear = () => {
      if (this.sidebarRead === pending) this.sidebarRead = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  };

  sidebarCommand: WorkspaceMethods["sidebarCommand"] = sidebarCommands.sidebarCommand.bind(
    this.features.sidebarCommands,
  );

  resumeId: WorkspaceMethods["resumeId"] = worktreeLaunch.resumeId.bind(
    this.features.worktreeLaunch,
  );

  startExisting: WorkspaceMethods["startExisting"] = worktreeLaunch.startExisting.bind(
    this.features.worktreeLaunch,
  );

  orchestrationView: WorkspaceMethods["orchestrationView"] =
    orchestrationCommands.orchestrationView.bind(this.features.orchestrationCommands);

  /**
   * The session menu's Make orchestrator: main swaps the running session's grant, so no
   * relaunch or reconnect is needed. One orchestrator per repository; another active one
   * is revoked once the human accepts the transfer, and its children stay with the human.
   */
  makeOrchestrator: WorkspaceMethods["makeOrchestrator"] =
    orchestrationCommands.makeOrchestrator.bind(this.features.orchestrationCommands);

  /** Ends orchestration as exit does; the session keeps running as an ordinary agent. */
  revokeOrchestrator: WorkspaceMethods["revokeOrchestrator"] =
    orchestrationCommands.revokeOrchestrator.bind(this.features.orchestrationCommands);

  /** A new branch and worktree for an orchestrator child, under the same branch lock. */
  createChildWorktree: WorkspaceMethods["createChildWorktree"] =
    orchestrationCommands.createChildWorktree.bind(this.features.orchestrationCommands);

  /** An ordinary child with a read-only grant, no bypass defaults and no confirmation prompts. */
  launchChild: WorkspaceMethods["launchChild"] = orchestrationCommands.launchChild.bind(
    this.features.orchestrationCommands,
  );

  subscribeExecution(listener: (event: ExecutionTransition) => void): () => void {
    return this.executionOwner.subscribeExecution(listener);
  }

  /** Evaluations remain ordered across invocations reusing the same terminal ID. */
  enqueue: WorkspaceMethods["enqueue"] = orchestrationCommands.enqueue.bind(
    this.features.executionEvents,
  );

  foreground: WorkspaceMethods["foreground"] = orchestrationCommands.foreground.bind(
    this.features.executionEvents,
  );
  shellState: WorkspaceMethods["shellState"] = orchestrationCommands.shellState.bind(
    this.features.executionEvents,
  );
  output: WorkspaceMethods["output"] = orchestrationCommands.output.bind(
    this.features.executionEvents,
  );
  evidence: WorkspaceMethods["evidence"] = orchestrationCommands.evidence.bind(
    this.features.executionEvents,
  );
  quiet: WorkspaceMethods["quiet"] = orchestrationCommands.quiet.bind(
    this.features.executionEvents,
  );

  /** Resolve per-launch capabilities and persist validated conversation identity here. */
  hook: WorkspaceMethods["hook"] = orchestrationCommands.hook.bind(this.features.executionEvents);

  exited: WorkspaceMethods["exited"] = orchestrationCommands.exited.bind(
    this.features.executionEvents,
  );

  removed: WorkspaceMethods["removed"] = orchestrationCommands.removed.bind(
    this.features.executionEvents,
  );

  input: WorkspaceMethods["input"] = orchestrationCommands.input.bind(
    this.features.executionEvents,
  );
  feedback: WorkspaceMethods["feedback"] = orchestrationCommands.feedback.bind(
    this.features.executionEvents,
  );

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
