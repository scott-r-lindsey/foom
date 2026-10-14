import { providerRevision } from "../agents/providers/registry";
import { builtinAgent } from "../../shared/providers/catalog";
import { ControlError } from "../control/validation";
import type { ForgeTracking } from "../control/forge-tracking";
import { CleanupRun, KeptWorktree } from "./cleanup-run";
import type { CleanupCandidate } from "./cleanup-run";
import type { CleanupReason } from "../../shared/cleanup";
import type { McpConnection } from "../../shared/workspace";
import { homeDirectory, homeShellFacts, shellPath } from "./home-shell";
import type { AgyPluginAction } from "../../shared/agy-plugin";
import { AgyPlugin } from "../agents/agy-plugin";
import { CodexHookStatus } from "../agents/codex-hook-status";
import { codexObserverCommand } from "../agents/codex-hooks";
import { createHash } from "node:crypto";
import { AgentExecution } from "../agents/execution";
import type { ExecutionPhase, ExecutionSource, ExecutionTransition } from "../../shared/execution";
import { conversationId, resumeArguments } from "../agents/conversation";
import { restorePlan, restoreAuthority, runRestore } from "./session-restore";
import type { StoredSession } from "./session-restore.d";
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
import { prepareHookLaunch } from "../agents/hook-launch";
import type { HookRegistrar } from "../agents/hook-launch";
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
  execution?: AgentExecution;
  codexHealthLaunch?: number;
  codexPromptTurn?: number;
  codexStarted?: boolean;
  codexStoppedTurn?: number;
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
  codexHooks?: CodexHookStatus;
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
  receiver: () => Promise<HookRegistrar & { close(): Promise<void> }>;
  /** Release checkout resources before Git removal; restore availability afterward. */
  prepareWorktreeRemoval?(worktree: string): Promise<() => void>;
  onExecution?(event: ExecutionTransition): void;
  onState(state: TerminalState): void;
  onChange?(): void;
  watcher?: Pick<InventoryWatch, "sync" | "dispose">;
  acknowledgeCodex(): Promise<void>;
  acknowledgeAgyPluginOffer?(): Promise<void>;
  forge?: ForgeTracking;
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
  private readonly codexHooks: CodexHookStatus;
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
  private location: "root" | "adjacent" = "root";
  private acknowledged = false;
  private hooksEnabled = true;
  private concurrentChildren = 4;
  private autoRemoveMergedWorktrees = false;
  private defaultArguments = EMPTY_AGENT_ARGUMENTS;
  private readonly resumeStarts = new Map<string, Promise<void>>();
  private readonly busySessions = new Set<string>();
  private readonly busyWorktrees = new Set<string>();
  private readonly repositoryOperations = new Map<string, Set<symbol>>();
  private readonly removingRepositories = new Set<string>();
  private readonly cleanupRuns = new Map<string, CleanupRun>();
  private readonly mergeScans = new Map<string, Set<Promise<void>>>();
  private readonly mergeEligibility = new Map<
    string,
    {
      key: string;
      count: number;
      expires: number;
      plan?: readonly CleanupCandidate[];
      result: { canDeleteMerged: boolean; mergedCount?: number; mergedError?: string };
    }
  >();
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
    this.codexHooks = deps.codexHooks ?? new CodexHookStatus();
    deps.watcher?.sync(deps.worktrees.listRepositories());
    const prepare = async (agent: AgentId): Promise<AgentHooks> => {
      // A receiver that failed to start is retried on the next launch.
      this.receiver ??= deps.receiver().catch((error: unknown) => {
        this.receiver = undefined;
        throw error;
      });
      const healthLaunch = builtinAgent(agent)?.hookHealth ? this.codexHooks.begin() : undefined;
      const binding = await prepareHookLaunch(await this.receiver, agent, (key, terminalId) => {
        if (terminalId) {
          this.hookKeys.set(key, terminalId);
          this.execution(terminalId);
          if (healthLaunch !== undefined) this.track(terminalId).codexHealthLaunch = healthLaunch;
        } else this.hookKeys.delete(key);
      });
      return builtinAgent(agent)?.hookHealth
        ? {
            ...binding,
            lifecycleCommand: codexObserverCommand(),
            notifyFallback: this.codexHooks.get() !== "trusted",
          }
        : binding;
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
        starting: (id) => this.restoring.has(id),
        reply: async (id, data) => {
          if (!this.deps.terminals.reply) throw new Error("Reply adapter unavailable");
          this.input(id);
          await this.deps.terminals.reply(id, data);
        },
        reveal: (id) => this.deps.reveal?.(id),
        tail: (id, lines) => this.deps.terminals.tail(id, lines),
        remove: async (repository, worktree, identity, confirm, revalidate) => {
          const tree = (await this.worktrees(repository)).find((item) => item.path === worktree);
          if (!tree || tree.path === repository) throw new Error("Worktree is unavailable");
          // removeTree holds the branch lock while it calls this, so no launch can slip in.
          const available = async () => {
            this.requireIdleWorktree(worktree);
            if ((await this.deps.worktrees.launchIdentity(repository, worktree)) !== identity)
              throw new Error("Worktree has changed");
            revalidate();
          };
          const removed = await this.removeTree(
            repository,
            worktree,
            tree.branch,
            async (branch, changes, automatic = false) => {
              await available();
              const accepted = await confirm(branch, changes, automatic);
              if (accepted) await available();
              return accepted;
            },
            available,
            false,
            async () => {
              await available();
              if (!this.autoRemoveMergedWorktrees) return false;
              const eligible = await this.deps.worktrees.canAutoRemove(
                repository,
                worktree,
                identity,
              );
              await available();
              return eligible && this.autoRemoveMergedWorktrees;
            },
          );
          this.refresh();
          return removed;
        },
        dialog: (content, signal) => this.deps.dialog?.(content, signal) ?? Promise.resolve(false),
        changed: () => {
          if (!this.closed) {
            this.persist();
            this.deps.onChange?.();
          }
        },
      },
      this.now,
      () => this.concurrentChildren,
    );
    this.agents = deps.agents
      ? deps.agents(prepare, prepareControl)
      : new AgentService(deps.worktrees, deps.terminals, prepare, prepareControl, this.agyPlugin);
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
          | "restoreSessions"
          | "concurrentChildren"
          | "autoRemoveMergedWorktrees"
        >
      >,
  ): void {
    this.restoreEnabled = settings.restoreSessions ?? true;
    this.concurrentChildren = settings.concurrentChildren ?? 4;
    this.autoRemoveMergedWorktrees = settings.autoRemoveMergedWorktrees ?? false;
    this.agents.setHooksEnabled(settings.hooks);
    this.hooksEnabled = settings.hooks;
    this.defaultArguments = settings.agentArguments ?? EMPTY_AGENT_ARGUMENTS;
    this.enabled = settings.agents;
    this.location = settings.worktreeLocation ?? "root";
    this.acknowledged = settings.codexNotifierAcknowledged ?? false;
  }

  private restoreEnabled = true;
  private readonly saved = new Map<string, StoredSession>();
  private readonly repositoryIdentities = new Map<string, string>();
  private readonly restoring = new Set<string>();
  private readonly unrestoredRoles = new Set<string>();
  private restoreWork: Promise<void> | undefined;
  private quitting = false;

  async restore(): Promise<void> {
    for (const entry of (await this.deps.sessions?.load()) ?? []) {
      if (
        entry.config
          ? entry.worktree !== this.deps.config?.root || entry.repository !== entry.worktree
          : entry.home
            ? entry.kind !== "shell" ||
              entry.worktree !== homeDirectory ||
              entry.repository !== homeDirectory
            : false
      )
        continue;
      this.saved.set(entry.id, entry);
      const row = { ...entry };
      delete row.running;
      delete row.orchestrator;
      delete row.parentId;
      this.launched.set(entry.id, row);
      this.track(entry.id).exitCode = -1;
    }
  }

  ownsSession(id: string): boolean {
    return this.launched.has(id);
  }

  private records(): StoredSession[] {
    return this.snapshot().terminals.map((entry) => {
      const role = this.orchestration.view(entry.id);
      const identity = this.repositoryIdentities.get(entry.repository);
      const saved = this.restoring.has(entry.id) ? this.saved.get(entry.id) : undefined;
      return {
        ...entry,
        ...(saved?.orchestrator ? { orchestrator: saved.orchestrator } : {}),
        ...(saved?.parentId ? { parentId: saved.parentId } : {}),
        running: this.restoring.has(entry.id) || !entry.exited,
        ...(role?.role === "orchestrator" && role.active && identity !== undefined
          ? {
              orchestrator: {
                identity,
                history: role.history,
                worktrees: this.orchestration.ownedWorktrees(entry.id),
                uncertain: this.orchestration.uncertainWorktrees(entry.id),
              },
            }
          : {}),
        ...(role?.role === "child" && !role.takenOver ? { parentId: role.parentId } : {}),
      };
    });
  }

  private persist(): void {
    if (this.quitting) return;
    void this.deps.sessions?.save(this.records()).catch((error: unknown) => {
      console.error("Unable to save sessions:", error);
    });
  }

  /** Freeze the pre-shutdown state, before stopping PTYs reports their exits. */
  async prepareQuit(): Promise<void> {
    await this.restoreWork;
    this.quitting = true;
    try {
      await this.deps.sessions?.save(this.records());
      await this.deps.sessions?.flush();
    } catch (error) {
      this.quitting = false;
      throw error;
    }
  }

  cancelQuit(): void {
    this.quitting = false;
    this.persist();
  }

  /** Called only after all saved windows have been shown. */
  restartSaved(): Promise<void> {
    if (this.restoreWork) return this.restoreWork;
    const plan = restorePlan([...this.saved.values()], this.restoreEnabled);
    for (const entry of plan) {
      this.restoring.add(entry.id);
      this.busySessions.add(entry.id);
    }
    this.deps.onChange?.();
    this.restoreWork = runRestore(plan, async (entry) => {
      try {
        if (this.quitting || this.closed || !this.restoreEnabled || !this.launched.has(entry.id))
          return;
        await this.restartSavedEntry(entry);
      } catch {
        this.track(entry.id).exitCode = -1;
        this.orchestration.exited(entry.id);
      } finally {
        if (this.launched.get(entry.id)?.dormant) this.orchestration.exited(entry.id);
        this.restoring.delete(entry.id);
        this.busySessions.delete(entry.id);
        this.saved.delete(entry.id);
        this.persist();
        this.deps.onChange?.();
      }
    });
    return this.restoreWork;
  }

  private async restartSavedEntry(entry: StoredSession): Promise<void> {
    const replacement = {
      id: entry.id,
      ...(entry.conversationId === undefined ? {} : { conversationId: entry.conversationId }),
    };
    const confirm: ConfirmWorkspace = () => Promise.resolve(false);
    if (entry.home) {
      await this.startHomeShell(entry.id);
      return;
    }
    if (entry.config) {
      await this.startConfig(entry.agent, confirm, replacement);
      return;
    }
    let control: AgentLaunch["control"];
    let authorityIdentity: string | undefined;
    let slot: ReturnType<Orchestration["reserve"]> | undefined;
    if (entry.orchestrator) {
      this.unrestoredRoles.add(entry.id);
      const identity = await this.deps.worktrees
        .launchIdentity(entry.repository, entry.repository)
        .catch(() => undefined);
      const scan = await this.scanAgents(false);
      if (
        restoreAuthority(
          entry,
          identity,
          scan.agents.find((agent) => agent.id === entry.agent),
          this.restoreEnabled,
        )
      ) {
        slot = this.orchestration.reserve(entry.repository);
        if (!("existing" in slot)) {
          control = { role: "orchestrator" };
          authorityIdentity = identity;
          if (identity !== undefined) this.repositoryIdentities.set(entry.repository, identity);
        }
      }
    } else if (
      entry.parentId &&
      (await this.orchestration.restoreChild(entry.parentId, { ...entry, exited: false }))
    ) {
      control = { parentId: entry.parentId };
    }
    try {
      const id = await this.startExisting(
        entry.repository,
        entry.worktree,
        entry.agent,
        confirm,
        replacement,
        control,
        true,
        authorityIdentity,
      );
      if (id && slot && !("existing" in slot)) {
        slot.bind(id);
        this.orchestration.restoreHistory(id, entry.orchestrator?.history ?? []);
        await this.orchestration.restoreWorktrees(
          id,
          entry.orchestrator?.worktrees ?? [],
          entry.orchestrator?.uncertain ?? 0,
        );
        this.unrestoredRoles.delete(id);
        for (const child of this.saved.values()) {
          if (child.parentId === id)
            await this.orchestration.restoreChild(id, {
              ...child,
              exited: !this.restoring.has(child.id),
            });
        }
      }
    } finally {
      if (slot && !("existing" in slot)) slot.release();
    }
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
    if (!state) return null;
    return terminal.hook?.action === "needs_input"
      ? { ...state, attentionKind: "permission" }
      : state;
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
          !this.restoring.has(entry.id) &&
          (entry.dormant === true || this.terminals.get(entry.id)?.exitCode !== undefined),
        ...this.orchestrationView(entry.id),
        ...(this.unrestoredRoles.has(entry.id) ? { roleNotRestored: true } : {}),
        mcpConnection: this.mcpConnections.get(entry.id),
      })),
    };
  }

  async addRepository(path: string): Promise<Repository> {
    const repository = await this.deps.worktrees.addRepository(path);
    this.refresh();
    return repository;
  }

  refresh(): void {
    if (this.closed) return;
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
    if (this.closed) throw new Error("Workspace is closed");
    this.known(repository);
    if (this.removingRepositories.has(repository) || this.repositoryOperations.has(repository))
      throw new Error("Repository is busy. Try again when its current operation finishes.");
    const checkSessions = () => {
      if ([...this.launched.values()].some((entry) => entry.repository === repository))
        throw new Error("Close this repository's sessions first");
    };
    checkSessions();
    this.removingRepositories.add(repository);
    try {
      if (confirm && !(await confirm())) return;
      checkSessions();
      await this.deps.worktrees.removeRepository(repository);
      this.cleanupRuns.delete(repository);
      this.mergeEligibility.delete(repository);
      this.refresh();
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
    this.scanned ??= this.agents.scan();
    try {
      const { warning, agents } = await this.scanned;
      return {
        warning,
        agents: agents.map((agent) =>
          agent.codexLifecycle ? { ...agent, codexHookState: this.codexHooks.get() } : agent,
        ),
      };
    } catch (error) {
      this.scanned = undefined;
      throw error;
    }
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
    extra: Pick<AgentLaunch, "control" | "prompt" | "conversationId"> = {},
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
      // Orchestrator children never inherit the user's (possibly bypass) defaults.
      const child = extra.control !== undefined && "parentId" in extra.control;
      const defaultArguments = child ? [] : (this.defaultArguments[request.agent] ?? []);
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
        this.repositoryIdentities.set(request.repository, checkoutIdentity);
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
        bypass: hasBypassArgument(request.agent, defaultArguments),
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
            request.acknowledgeCodexNotifierReplacement &&
            !this.acknowledged
          ) {
            await this.deps.acknowledgeCodex();
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
                acknowledgeCodexNotifierReplacement: this.acknowledged,
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
    return this.removeIdleTree(entry.repository, entry.worktree, entry.branch, confirm);
  }

  private hasRunningSession(worktree: string): boolean {
    return [...this.launched.values()].some(
      (entry) =>
        entry.worktree === worktree &&
        (this.restoring.has(entry.id) ||
          (!entry.dormant && this.terminals.get(entry.id)?.exitCode === undefined)),
    );
  }

  private requireIdleWorktree(worktree: string): void {
    if (this.hasRunningSession(worktree)) throw new Error("A session is running in this worktree");
  }

  private async removeIdleTree(
    repository: string,
    worktree: string,
    branch: string | null,
    confirm: (branch: string, changes: string) => Promise<boolean>,
  ): Promise<boolean> {
    this.requireIdleWorktree(worktree);
    return this.removeTree(
      repository,
      worktree,
      branch,
      (name, changes) => {
        this.requireIdleWorktree(worktree);
        return confirm(name, changes);
      },
      () => {
        this.requireIdleWorktree(worktree);
      },
    );
  }

  private async removeTree(
    repository: string,
    worktree: string,
    branch: string | null,
    confirm: (branch: string, changes: string, automatic?: boolean) => Promise<boolean>,
    revalidate?: () => void | Promise<void>,
    retainBranchLock = false,
    autoApprove?: () => Promise<boolean>,
  ): Promise<boolean> {
    const entry = { repository, worktree, branch };
    const key = `${entry.repository}\0${entry.branch ?? ""}`;
    if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
    this.busyWorktrees.add(key);
    let removed = false;
    try {
      const identity = await this.deps.worktrees.removalIdentity(entry.repository, entry.worktree);
      let changes = await this.deps.worktrees.changes(entry.repository, entry.worktree, identity);
      const automatic = changes === "" && (await autoApprove?.()) === true;
      const accepted = automatic
        ? await confirm(entry.branch ?? entry.worktree, changes, true)
        : await confirm(entry.branch ?? entry.worktree, changes);
      if (!accepted) return false;
      await revalidate?.();
      if (
        !automatic &&
        (await this.deps.worktrees.changes(entry.repository, entry.worktree, identity)) !== changes
      )
        throw new Error("Worktree changes have changed. Review them and try again.");
      const entries = [...this.launched.values()].filter(
        (item) => item.worktree === entry.worktree,
      );
      for (const item of entries) {
        if (item.dormant) continue;
        await this.deps.terminals.stop(item.id);
        await this.exited(item.id, -1);
      }
      await revalidate?.();
      if (
        !automatic &&
        (await this.deps.worktrees.changes(entry.repository, entry.worktree, identity)) !== changes
      )
        throw new Error("Worktree changes have changed. Review them and try again.");
      await revalidate?.();
      if (automatic && !(await autoApprove?.())) {
        changes = await this.deps.worktrees.changes(entry.repository, entry.worktree, identity);
        if (!(await confirm(entry.branch ?? entry.worktree, changes))) return false;
        await revalidate?.();
        if (
          (await this.deps.worktrees.changes(entry.repository, entry.worktree, identity)) !==
          changes
        )
          throw new Error("Worktree changes have changed. Review them and try again.");
      }
      await revalidate?.();
      const release = await this.deps.prepareWorktreeRemoval?.(entry.worktree);
      try {
        await this.deps.worktrees.removeWorktree(
          entry.repository,
          entry.worktree,
          changes.length > 0,
          identity,
        );
      } finally {
        release?.();
      }
      for (const item of entries) {
        if (!item.dormant) await this.deps.terminals.kill(item.id);
        this.removed(item.id);
      }
      removed = true;
      return true;
    } finally {
      if (!retainBranchLock || !removed) this.busyWorktrees.delete(key);
    }
  }

  private sessionSkip(worktree: string): CleanupReason | undefined {
    const sessions = [...this.launched.values()].filter((item) => item.worktree === worktree);
    if (sessions.some((item) => this.terminals.get(item.id)?.exitCode === undefined))
      return "running";
    if (sessions.some((item) => item.kind === "agent" && conversationId(item.conversationId)))
      return "resumable conversation";
    return undefined;
  }

  private async mergedPlan(repository: string, refresh: boolean, inventory?: readonly Worktree[]) {
    const trees = inventory ?? (await this.worktrees(repository));
    if (!trees.some((tree) => tree.path !== repository && !tree.bare)) return [];
    const base = await this.deps.worktrees.mergedDefault(repository, refresh);
    return Promise.all(
      trees.map(async (tree) => {
        let reason: CleanupReason | undefined;
        if (tree.path === repository || tree.bare) reason = "main checkout";
        else if (tree.locked || tree.prunable || !tree.branch) reason = "unavailable";
        else reason = this.sessionSkip(tree.path);
        if (!reason) {
          try {
            if (await this.deps.worktrees.changes(repository, tree.path))
              reason = "uncommitted changes";
            else if (!(await this.deps.worktrees.mergedCommit(repository, tree, base)))
              reason = "not merged";
          } catch {
            reason = "unavailable";
          }
        }
        if (reason) return { tree, reason };
        try {
          return {
            tree,
            reason,
            identity: await this.deps.worktrees.removalIdentity(repository, tree.path),
          };
        } catch {
          return { tree, reason: "unavailable" as const };
        }
      }),
    );
  }

  private async deleteMerged(repository: string, confirm: ConfirmWorkspace): Promise<void> {
    this.known(repository);
    const existing = this.cleanupRuns.get(repository);
    if (existing && (existing.pending || existing.current().stage === "run")) {
      await confirm({
        kind: "merged-worktrees",
        subject: basename(repository),
        worktrees: [],
        feed: existing,
      });
      if (!existing.pending) {
        this.cleanupRuns.delete(repository);
        this.refresh();
      }
      return;
    }
    return this.withRepository(repository, async () => {
      const run = new CleanupRun({
        checkingCount: this.mergeEligibility.get(repository)?.count,
        fetchedAt: () => this.deps.worktrees.mergedFetchTime(repository),
        fetch: async () => {
          // Windows cannot remove a checkout while a background Git process uses it as cwd.
          // Include superseded scans too: their publication is discarded, but they still run.
          await Promise.all([...(this.mergeScans.get(repository) ?? [])]);
          return this.deps.worktrees.mergedDefault(repository, true);
        },
        changed: () => {
          this.refresh();
        },
        branches: async (removed) => {
          try {
            return await this.deps.worktrees.deleteMergedBranches(
              repository,
              removed.flatMap(({ tree }) =>
                tree.branch && tree.head ? [{ branch: tree.branch, head: tree.head }] : [],
              ),
            );
          } finally {
            for (const { tree } of removed)
              this.busyWorktrees.delete(`${repository}\0${tree.branch ?? ""}`);
          }
        },
        remove: async ({ tree, identity }, base) => {
          const revalidate = async () => {
            const current = (await this.worktrees(repository)).find(
              (item) => item.path === tree.path,
            );
            if (
              !current ||
              current.branch !== tree.branch ||
              current.head !== tree.head ||
              (await this.deps.worktrees.removalIdentity(repository, tree.path)) !== identity
            )
              throw new KeptWorktree("worktree changed");
            const reason = this.sessionSkip(tree.path);
            if (reason) throw new KeptWorktree(reason);
            if (await this.deps.worktrees.changes(repository, tree.path))
              throw new KeptWorktree("uncommitted changes");
            if (!(await this.deps.worktrees.mergedCommit(repository, current, base)))
              throw new KeptWorktree("not merged");
          };
          await this.removeTree(
            repository,
            tree.path,
            tree.branch,
            async () => {
              await revalidate();
              return true;
            },
            revalidate,
            true,
          );
        },
      });
      this.cleanupRuns.set(repository, run);
      const cached = this.mergeEligibility.get(repository);
      const prepare =
        cached?.plan && this.now() < cached.expires
          ? Promise.resolve(cached.plan)
          : this.mergedPlan(repository, true);
      if (cached?.plan && this.now() < cached.expires) run.ready(cached.plan);
      // Request presentation before awaiting network or filesystem checks.
      const answer = confirm({
        kind: "merged-worktrees",
        subject: basename(repository),
        worktrees: [],
        feed: run,
      });
      try {
        run.ready(await prepare);
      } catch {
        run.failed();
      }
      if (await answer) run.act();
      const reviewed = run.current().stage === "run" && !run.pending;
      // Hide resolves presentation, but the repository reservation lasts through the run.
      await run.settled();
      if (reviewed || run.current().stage !== "run") {
        this.cleanupRuns.delete(repository);
        this.refresh();
      }
    });
  }

  /** Never let remote discovery hold up local inventory or session publication. */
  private cachedMergeEligibility(repository: string, worktrees: readonly Worktree[]) {
    if (this.cleanupRuns.get(repository)?.pending)
      return this.mergeEligibility.get(repository)?.result ?? { canDeleteMerged: false };
    if (this.closed || !worktrees.some((tree) => tree.path !== repository && !tree.bare)) {
      this.mergeEligibility.delete(repository);
      return { canDeleteMerged: false };
    }
    const key = JSON.stringify(worktrees.map((tree) => [tree, this.sessionSkip(tree.path)]));
    const cached = this.mergeEligibility.get(repository);
    if (cached?.key === key && this.now() < cached.expires) return cached.result;
    const entry: {
      key: string;
      count: number;
      expires: number;
      result: { canDeleteMerged: boolean; mergedCount?: number; mergedError?: string };
      plan?: readonly CleanupCandidate[];
    } = {
      key,
      count: worktrees.length,
      expires: Number.POSITIVE_INFINITY,
      result: { canDeleteMerged: false },
    };
    this.mergeEligibility.set(repository, entry);
    const publish = (result: {
      canDeleteMerged: boolean;
      mergedCount?: number;
      mergedError?: string;
    }) => {
      // A newer inventory, repository removal or shutdown supersedes this scan.
      if (this.closed || this.mergeEligibility.get(repository) !== entry) return;
      entry.result = result;
      entry.expires = this.now() + 60_000;
      this.deps.onChange?.();
    };
    const scans = this.mergeScans.get(repository) ?? new Set<Promise<void>>();
    this.mergeScans.set(repository, scans);
    const scan: Promise<void> = this.mergedPlan(repository, false, worktrees)
      .then(
        (plan) => {
          entry.plan = plan;
          publish({
            canDeleteMerged: plan.some((item) => !item.reason),
            mergedCount: plan.filter((item) => !item.reason).length,
          });
        },
        (error: unknown) => {
          publish({
            canDeleteMerged: false,
            mergedError: error instanceof Error ? error.message : String(error),
          });
        },
      )
      .finally(() => {
        scans.delete(scan);
        if (scans.size === 0) this.mergeScans.delete(repository);
      });
    scans.add(scan);
    return entry.result;
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
        !this.acknowledged &&
        scan.agents.some(
          (agent) =>
            builtinAgent(agent.id)?.hookHealth && agent.hooks && agent.codexHookState !== "trusted",
        )
      ) {
        if (!(await confirm({ kind: "notifier" }))) return;
        await this.deps.acknowledgeCodex();
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
          acknowledgeCodexNotifierReplacement: this.acknowledged,
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
        bypass: hasBypassArgument(run, defaultArguments),
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
          return {
            ...repository,
            worktrees: [
              ...worktrees,
              ...(this.cleanupRuns
                .get(repository.path)
                ?.removedTrees.filter(
                  (tree) => !worktrees.some((current) => current.path === tree.path),
                ) ?? []),
            ],
            ...this.cachedMergeEligibility(repository.path, worktrees),
            ...(this.cleanupRuns.get(repository.path)?.current().stage === "run"
              ? { cleanup: this.cleanupRuns.get(repository.path)?.progress }
              : {}),
          };
        }),
      ),
      shell:
        process.platform === "win32"
          ? "powershell.exe"
          : basename(process.env["SHELL"] || "/bin/bash"),
    };
  }

  async sidebarCommand(command: SidebarCommand, confirm: ConfirmWorkspace): Promise<void> {
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
      return this.deleteMerged(command.repository, confirm);
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
    await this.removeIdleTree(command.repository, tree.path, tree.branch, (branch, changes) =>
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
            !this.acknowledged &&
            scan.agents.some(
              (agent) =>
                builtinAgent(agent.id)?.hookHealth &&
                agent.hooks &&
                agent.codexHookState !== "trusted",
            )
          ) {
            if (!(await confirm({ kind: "notifier" }))) return;
            await this.deps.acknowledgeCodex();
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
                  acknowledgeCodexNotifierReplacement: this.acknowledged,
                },
                worktree === repository,
                true,
                identity,
                replacement,
                {
                  ...(pastedId === undefined ? {} : { conversationId: pastedId }),
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

  private orchestrationView(id: string): Pick<WorkspaceTerminal, "orchestration"> {
    const view = this.orchestration.view(id);
    return view ? { orchestration: view } : {};
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
        this.restoring.has(id) ||
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
        this.repositoryIdentities.set(entry.repository, identity);
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
            acknowledgeCodexNotifierReplacement: this.acknowledged,
          },
          false,
          false,
          identity,
          undefined,
          { control: { parentId }, ...(prompt === undefined ? {} : { prompt }) },
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
    if (
      phase === "idle" &&
      event.from === "working" &&
      source !== "hook" &&
      builtinAgent(this.launched.get(id)?.agent)?.hookHealth &&
      terminal.codexPromptTurn !== event.turn &&
      this.codexHooks.get() === "trusted"
    )
      this.codexHooks.set("declined", terminal.codexHealthLaunch);
    if (phase === "exited" && event.from === "working") terminal.interrupted = true;
  }

  private completionHook(id: string): boolean {
    const entry = this.launched.get(id);
    return (
      entry?.attention === "hooks" &&
      Boolean(
        !builtinAgent(entry.agent) ||
          builtinAgent(entry.agent)?.completionHook ||
          (builtinAgent(entry.agent)?.hookHealth && this.track(id).codexPromptTurn !== undefined),
      )
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
    this.deps.onState(terminal.state);
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
    if (
      builtinAgent(this.launched.get(id)?.agent)?.hookHealth &&
      terminal.exitCode === undefined &&
      terminal.codexHealthLaunch !== undefined &&
      tail.slice(-20).some((line) => line.includes("Hooks need review"))
    ) {
      this.codexHooks.set(
        ["trusted", "outdated"].includes(this.codexHooks.get()) ? "outdated" : "not-reviewed",
        terminal.codexHealthLaunch,
      );
    }
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
    if (signal.action === "ready" && signal.signal.startsWith("plugin:")) {
      this.transition(id, "idle", "hook");
      return Promise.resolve();
    }
    if (signal.signal === "codex:SessionStart") {
      health.codexStarted = true;
      return Promise.resolve();
    }
    const turn = this.execution(id).snapshot().turn;
    if (signal.signal === "codex:Stop") {
      health.codexStoppedTurn = turn;
      if (health.codexStarted && health.codexPromptTurn === turn)
        this.codexHooks.set("trusted", health.codexHealthLaunch);
    }
    if (signal.signal === "codex:agent-turn-complete") {
      if (health.codexPromptTurn !== turn)
        this.codexHooks.set("declined", health.codexHealthLaunch);
      // Stop is authoritative; do not classify the same turn twice through notify.
      if (health.codexStoppedTurn === turn) return Promise.resolve();
    }
    if (signal.action === "working") {
      this.track(id).generation++;
      this.transition(id, "working", "hook");
      if (signal.signal === "codex:UserPromptSubmit")
        health.codexPromptTurn = this.execution(id).snapshot().turn;
      return Promise.resolve();
    }
    // A fully idle Stop proves a turn ran even when its background start report
    // was overtaken. Recover the turn identity before classifying completion.
    if (
      signal.signal === "agy:Stop" &&
      signal.action === "classify" &&
      signal.terminationReason === "model_stop" &&
      signal.fullyIdle === true &&
      this.execution(id).snapshot().phase !== "working"
    )
      this.transition(id, "working", "hook");
    if (signal.action === "failed") {
      this.track(id).hook = { terminalId: id, action: signal.action, signal: signal.signal };
      this.transition(id, "idle", "hook");
    } else if (signal.action === "needs_input") {
      delete this.track(id).permissionReply;
      delete this.track(id).permissionProgress;
      delete this.track(id).dismissedAttention;
      this.track(id).hook = { terminalId: id, action: signal.action, signal: signal.signal };
      this.transition(id, "blocked", "hook");
    } else if (signal.signal !== "claude:idle_prompt") {
      const terminal = this.track(id);
      const turn = terminal.execution?.snapshot().turn;
      if (
        turn &&
        (signal.signal.startsWith("plugin:") ||
          signal.signal === "agy:Stop" ||
          signal.signal === "claude:Stop" ||
          signal.signal === "codex:Stop" ||
          signal.signal === "codex:agent-turn-complete")
      )
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
    for (const run of this.cleanupRuns.values()) run.stop();
    await Promise.all([...this.cleanupRuns.values()].map((run) => run.settled()));
    this.cleanupRuns.clear();
    this.mergeEligibility.clear();
    this.executionListeners.clear();
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
        await this.deps.sessions?.flush();
        await this.codexHooks.flush();
      }
    }
  }
}
