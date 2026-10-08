import { createHash } from "node:crypto";
import { AgentExecution } from "../agents/execution";
import type { ExecutionPhase, ExecutionSource, ExecutionTransition } from "../../shared/execution";
import { conversationId, resumeArguments } from "../agents/conversation";
import type { SessionStore } from "./session-store";
import type { InventoryWatch } from "./inventory-watch";
import type { ControlLaunch } from "../control/types";
import type { ControlRuntime } from "../control/runtime";
import type { ConfirmWorkspace } from "../../shared/confirmation";
import { EMPTY_AGENT_ARGUMENTS, hasBypassArgument } from "../agents/default-arguments";
import { detectAgent, ruleRegion } from "../evaluator/agent-rules";
import type { AgentEvidence } from "../../shared/agent-detection";
import { basename } from "node:path";
import type { SidebarCommand, SidebarInventory } from "../../shared/workspace";
import { AgentService } from "../agents/agents";
import { prepareHookLaunch } from "../agents/hook-launch";
import type { HookRegistrar } from "../agents/hook-launch";
import type { AgentHooks, AgentId } from "../../shared/agents";
import type { TerminalSpec, ShellState } from "../../shared/desktop";
import type { EvaluationInput, VerdictAction, VerdictRecord } from "../../shared/evaluator";
import type { HookSignal } from "../../shared/hooks";
import type { Settings } from "../../shared/setup";
import type { Repository, Worktree } from "../../shared/worktrees";
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
  completedTurn?: number;
  interrupted?: boolean;
  actionVerdict?: string;
  attentionKey?: string;
  dismissedAttention?: string;
  evidence?: AgentEvidence;
  shellRunning?: boolean;
  exitCode?: number;
  hook?: HookSignal;
  permissionReply?: boolean;
  permissionProgress?: boolean;
  state: TerminalState | null;
  /** Bumped by replies and dismissals; evaluations that began earlier are discarded. */
  generation: number;
  outputVersion: number;
};

export interface WorkspaceDependencies {
  worktrees: Pick<
    WorktreeService,
    | "listRepositories"
    | "addRepository"
    | "listWorktrees"
    | "createWorktree"
    | "validateBranch"
    | "changes"
    | "removalIdentity"
    | "launchIdentity"
    | "removeWorktree"
    | "removeRepository"
    | "mergedDefault"
    | "mergedCommit"
    | "deleteMergedBranch"
  >;
  terminals: {
    create(spec: TerminalSpec): Promise<string>;
    kill(id: string): Promise<void>;
    stop(id: string): Promise<void>;
    tail(id: string, lines: number): Promise<string[]>;
  };
  verdicts: {
    classify(input: EvaluationInput): Promise<VerdictRecord>;
    commit(record: VerdictRecord): Promise<void>;
    forget(terminalId: string): void;
    recordAction(terminalId: string, verdictId: string, action: VerdictAction): Promise<void>;
  };
  /** Started on the first agent launch, independently of hook support. */
  control?: () => Promise<Pick<ControlRuntime, "prepare" | "close">>;
  /** Started on the first launch that attaches hooks, then reused. */
  receiver: () => Promise<HookRegistrar & { close(): Promise<void> }>;
  onExecution?(event: ExecutionTransition): void;
  onState(state: TerminalState): void;
  onChange?(): void;
  watcher?: Pick<InventoryWatch, "sync" | "dispose">;
  acknowledgeCodex(): Promise<void>;
  sessions?: Pick<SessionStore, "load" | "save" | "flush">;
  copyText?(text: string): void | Promise<void>;
  agents?: (
    prepare: (agent: AgentId) => Promise<AgentHooks>,
    control?: (repository: string, worktree: string, sessionId?: string) => Promise<ControlLaunch>,
  ) => Agents;
  now?: () => number;
}

/**
 * Main-process integration: launches agents into managed worktrees, turns quiet events,
 * exits and hook signals into verdicts, and reports state. Terminal IDs are the only
 * identifiers crossing into evaluation; agent text never does.
 */
export class Workspace {
  private readonly agents: Agents;
  private launchSequence = 0;
  private readonly executionListeners = new Set<(event: ExecutionTransition) => void>();
  private readonly launched = new Map<string, WorkspaceTerminal>();
  private readonly terminals = new Map<string, Terminal>();
  private readonly hookKeys = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();
  private control: Promise<Pick<ControlRuntime, "prepare" | "close">> | undefined;
  private receiver: ReturnType<WorkspaceDependencies["receiver"]> | undefined;
  private scanned: ReturnType<Agents["scan"]> | undefined;
  private closed = false;
  private location: "root" | "adjacent" = "root";
  private acknowledged = false;
  private hooksEnabled = true;
  private defaultArguments = EMPTY_AGENT_ARGUMENTS;
  private readonly busySessions = new Set<string>();
  private readonly busyWorktrees = new Set<string>();
  private readonly repositoryOperations = new Map<string, Set<symbol>>();
  private readonly removingRepositories = new Set<string>();
  private enabled: Readonly<Record<AgentId, boolean>> = { claude: true, codex: true, agy: true };
  private readonly now: () => number;

  constructor(private readonly deps: WorkspaceDependencies) {
    this.now = deps.now ?? Date.now;
    deps.watcher?.sync(deps.worktrees.listRepositories());
    const prepare = async (agent: AgentId): Promise<AgentHooks> => {
      if (agent === "agy") throw new Error("Antigravity hooks are not supported");
      // A receiver that failed to start is retried on the next launch.
      this.receiver ??= deps.receiver().catch((error: unknown) => {
        this.receiver = undefined;
        throw error;
      });
      return prepareHookLaunch(await this.receiver, agent, (key, terminalId) => {
        if (terminalId) {
          this.hookKeys.set(key, terminalId);
          this.execution(terminalId);
        } else this.hookKeys.delete(key);
      });
    };
    const startControl = deps.control;
    const prepareControl = startControl
      ? async (
          repository: string,
          worktree: string,
          sessionId?: string,
        ): Promise<ControlLaunch> => {
          this.control ??= startControl().catch((error: unknown) => {
            this.control = undefined;
            throw error;
          });
          return (await this.control).prepare(repository, worktree, sessionId);
        }
      : undefined;
    this.agents = deps.agents
      ? deps.agents(prepare, prepareControl)
      : new AgentService(deps.worktrees, deps.terminals, prepare, prepareControl);
  }

  /** Setup's choices apply to later launches; running agents keep theirs. */
  configure(
    settings: Pick<Settings, "hooks" | "agents"> &
      Partial<Pick<Settings, "worktreeLocation" | "codexNotifierAcknowledged" | "agentArguments">>,
  ): void {
    this.agents.setHooksEnabled(settings.hooks);
    this.hooksEnabled = settings.hooks;
    this.defaultArguments = settings.agentArguments ?? EMPTY_AGENT_ARGUMENTS;
    this.enabled = settings.agents;
    this.location = settings.worktreeLocation ?? "root";
    this.acknowledged = settings.codexNotifierAcknowledged ?? false;
  }

  async restore(): Promise<void> {
    for (const entry of (await this.deps.sessions?.load()) ?? []) {
      if (!this.deps.worktrees.listRepositories().some((repo) => repo.path === entry.repository))
        continue;
      this.launched.set(entry.id, entry);
      this.track(entry.id).exitCode = -1;
    }
  }

  ownsSession(id: string): boolean {
    return this.launched.has(id);
  }

  private persist(): void {
    void this.deps.sessions?.save([...this.launched.values()]).catch((error: unknown) => {
      console.error("Unable to save sessions:", error);
    });
  }

  snapshot(): WorkspaceSnapshot {
    return {
      repositories: this.deps.worktrees.listRepositories(),
      terminals: [...this.launched.values()].map((entry) => ({
        ...entry,
        ...(this.terminals.get(entry.id)?.execution
          ? { execution: this.terminals.get(entry.id)?.execution?.snapshot() }
          : {}),
        state: this.terminals.get(entry.id)?.state ?? null,
        exited: entry.dormant === true || this.terminals.get(entry.id)?.exitCode !== undefined,
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
      this.refresh();
    } finally {
      this.removingRepositories.delete(repository);
    }
  }

  async worktrees(repository: string): Promise<readonly Worktree[]> {
    this.known(repository);
    return this.deps.worktrees.listWorktrees(repository);
  }

  async createWorktree(
    repository: string,
    branch: string,
    location: "root" | "adjacent",
  ): Promise<Worktree> {
    return this.withRepository(repository, async () => {
      const path = await this.deps.worktrees.createWorktree(repository, branch, { location });
      const created = (await this.deps.worktrees.listWorktrees(repository)).find(
        (tree) => tree.path === path,
      );
      if (!created) throw new Error("Created worktree is missing");
      return created;
    });
  }

  async scanAgents(refresh: boolean): Promise<AgentReport> {
    if (refresh) this.scanned = undefined;
    this.scanned ??= this.agents.scan();
    try {
      const { warning, agents } = await this.scanned;
      return { warning, agents };
    } catch (error) {
      this.scanned = undefined;
      throw error;
    }
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
        if (!(await this.confirmAgentLaunch(request.worktree, confirm))) return null;
        return await this.launchAgent(request, false, true);
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
  ): Promise<{ id: string; attention: "hooks" | "evaluator" }> {
    return this.withRepository(request.repository, async () => {
      if (!this.enabled[request.agent]) throw new Error("This agent is turned off in preflight");
      // Scan once so launches don't each probe the login shell.
      await this.scanAgents(false);
      // Look up the branch before spawning, so nothing can fail between spawn and tracking.
      const tree = (await this.deps.worktrees.listWorktrees(request.repository)).find(
        (entry) => entry.path === request.worktree,
      );
      const defaultArguments = this.defaultArguments[request.agent];
      const result = await this.agents.launch({
        ...request,
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
      });
      const launchVersion = replacement
        ? (this.launched.get(replacement.id)?.launchVersion ?? 0) + 1
        : undefined;
      this.launched.set(result.id, {
        ...(launchVersion === undefined ? {} : { launchVersion }),
        id: result.id,
        kind: "agent",
        agent: request.agent,
        repository: request.repository,
        worktree: request.worktree,
        branch: tree?.branch ?? null,
        attention: result.attention,
        ...(replacement?.conversationId === undefined
          ? {}
          : { conversationId: replacement.conversationId }),
        bypass: hasBypassArgument(request.agent, defaultArguments),
        state: null,
      });
      const tracked = this.track(result.id);
      const execution = this.execution(result.id);
      if (tracked.exitCode !== undefined) execution.transition("exited", "exit");
      else if (tracked.evidence) void this.evidence(result.id, tracked.evidence, true);
      this.persist();
      this.refresh();
      return result;
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
        if (existing && !existing.managed)
          throw new Error("This branch is already checked out outside Foom");
        const tree =
          existing ??
          (await this.createWorktree(request.repository, request.branch, this.location));
        if (!tree.managed || tree.locked || tree.prunable)
          throw new Error("Worktree is unavailable");
        if (request.run !== "shell") {
          if (!(await this.confirmAgentLaunch(tree.path, confirm))) return null;
          if (
            request.run === "codex" &&
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
            )
          ).id;
        }
        const windows = process.platform === "win32";
        const id = await this.deps.terminals.create({
          command: windows ? "powershell.exe" : process.env["SHELL"] || "/bin/bash",
          args: windows ? ["-NoLogo"] : ["-l"],
          shellIntegration: true,
          cwd: tree.path,
          cols: 80,
          rows: 24,
        });
        this.launched.set(id, {
          id,
          kind: "shell",
          agent: "shell",
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
    return this.removeTree(entry.repository, entry.worktree, entry.branch, confirm);
  }

  private async removeTree(
    repository: string,
    worktree: string,
    branch: string | null,
    confirm: (branch: string, changes: string) => Promise<boolean>,
    revalidate?: () => Promise<void>,
  ): Promise<boolean> {
    const entry = { repository, worktree, branch };
    const key = `${entry.repository}\0${entry.branch ?? ""}`;
    if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
    this.busyWorktrees.add(key);
    try {
      const identity = await this.deps.worktrees.removalIdentity(entry.repository, entry.worktree);
      const changes = await this.deps.worktrees.changes(entry.repository, entry.worktree, identity);
      if (!(await confirm(entry.branch ?? entry.worktree, changes))) return false;
      if (
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
      if (
        (await this.deps.worktrees.changes(entry.repository, entry.worktree, identity)) !== changes
      )
        throw new Error("Worktree changes have changed. Review them and try again.");
      await revalidate?.();
      await this.deps.worktrees.removeWorktree(
        entry.repository,
        entry.worktree,
        changes.length > 0,
        identity,
      );
      for (const item of entries) {
        if (!item.dormant) await this.deps.terminals.kill(item.id);
        this.removed(item.id);
      }
      return true;
    } finally {
      this.busyWorktrees.delete(key);
    }
  }

  private sessionSkip(worktree: string): string | undefined {
    const sessions = [...this.launched.values()].filter((item) => item.worktree === worktree);
    if (sessions.some((item) => this.terminals.get(item.id)?.exitCode === undefined))
      return "running";
    if (
      sessions.some(
        (item) =>
          (item.agent === "claude" || item.agent === "codex") &&
          conversationId(item.conversationId),
      )
    )
      return "resumable conversation";
    return undefined;
  }

  private async mergedPlan(repository: string, refresh: boolean) {
    const trees = await this.worktrees(repository);
    if (!trees.some((tree) => tree.managed)) return [];
    const base = await this.deps.worktrees.mergedDefault(repository, refresh);
    return Promise.all(
      trees.map(async (tree) => {
        let reason: string | undefined;
        if (tree.path === repository || tree.bare) reason = "main checkout";
        else if (!tree.managed) reason = "not managed by Foom";
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
        return { tree, reason };
      }),
    );
  }

  private async deleteMerged(repository: string, confirm: ConfirmWorkspace): Promise<void> {
    return this.withRepository(repository, async () => {
      const plan = await this.mergedPlan(repository, true);
      const candidates = plan.filter((item) => !item.reason);
      if (!candidates.length) throw new Error("No merged worktrees can be deleted");
      const identities = new Map(
        await Promise.all(
          candidates.map(
            async ({ tree }) =>
              [
                tree.path,
                await this.deps.worktrees.removalIdentity(repository, tree.path),
              ] as const,
          ),
        ),
      );
      if (
        !(await confirm({
          kind: "merged-worktrees",
          worktrees: plan.map(({ tree, reason }) => ({
            branch: tree.branch ?? tree.path,
            ...(reason ? { reason } : {}),
          })),
        }))
      )
        return;
      // A failed fresh fetch refuses the entire action before any removal.
      const base = await this.deps.worktrees.mergedDefault(repository, true);
      const skipped: string[] = [];
      for (const { tree } of candidates) {
        const revalidate = async () => {
          const current = (await this.worktrees(repository)).find(
            (item) => item.path === tree.path,
          );
          if (
            !current?.managed ||
            current.branch !== tree.branch ||
            current.head !== tree.head ||
            (await this.deps.worktrees.removalIdentity(repository, tree.path)) !==
              identities.get(tree.path)
          )
            throw new Error("worktree changed");
          const reason = this.sessionSkip(tree.path);
          if (reason) throw new Error(reason);
          if (await this.deps.worktrees.changes(repository, tree.path))
            throw new Error("uncommitted changes");
          if (!(await this.deps.worktrees.mergedCommit(repository, current, base)))
            throw new Error("not merged");
        };
        try {
          await this.removeTree(
            repository,
            tree.path,
            tree.branch,
            async () => {
              await revalidate();
              return true;
            },
            revalidate,
          );
          if (tree.branch && tree.head)
            await this.deps.worktrees.deleteMergedBranch(repository, tree.branch, tree.head);
        } catch (error) {
          skipped.push(
            `${tree.branch ?? tree.path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      this.refresh();
      if (skipped.length) throw new Error(`Skipped: ${skipped.join("; ")}`);
    });
  }

  async sidebarInventory(): Promise<SidebarInventory> {
    return {
      repositories: await Promise.all(
        this.deps.worktrees.listRepositories().map(async (repository) => {
          const worktrees = await this.worktrees(repository.path);
          try {
            const plan = await this.mergedPlan(repository.path, false);
            return { ...repository, worktrees, canDeleteMerged: plan.some((item) => !item.reason) };
          } catch (error) {
            return {
              ...repository,
              worktrees,
              mergedError: error instanceof Error ? error.message : String(error),
            };
          }
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
    if ("id" in command && this.busySessions.has(command.id)) throw new Error("Session is busy");
    if (
      command.kind === "resume" ||
      command.kind === "new-conversation" ||
      command.kind === "copy-session-id"
    ) {
      const entry = this.launched.get(command.id);
      if (!entry || entry.agent === "shell") throw new Error("Unknown agent session");
      if (this.terminals.get(entry.id)?.exitCode === undefined)
        throw new Error("Session is still running");
      if (command.kind === "copy-session-id") {
        if (!conversationId(entry.conversationId)) throw new Error("No conversation ID recorded");
        await this.deps.copyText?.(entry.conversationId);
        return;
      }
      if (command.kind === "resume") resumeArguments(entry.agent, entry.conversationId);
      this.busySessions.add(entry.id);
      try {
        await this.startExisting(entry.repository, entry.worktree, entry.agent, confirm, {
          id: entry.id,
          ...(command.kind === "resume" && entry.conversationId !== undefined
            ? { conversationId: entry.conversationId }
            : {}),
        });
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
      if (command.kind === "restart") {
        if (!entry || entry.kind !== "shell") throw new Error("Only shells can restart");
        await this.startExisting(entry.repository, entry.worktree, "shell", confirm);
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
    await this.removeTree(command.repository, tree.path, tree.branch, (branch, changes) =>
      confirm(
        changes
          ? { kind: "dirty-worktree", title: `Remove ${branch}?`, changes }
          : { kind: "remove" },
      ),
    );
    this.refresh();
  }

  private async startExisting(
    repository: string,
    worktree: string,
    run: AgentId | "shell",
    confirm: ConfirmWorkspace,
    replacement?: { id: string; conversationId?: string },
  ): Promise<void> {
    return this.withRepository(repository, async () => {
      const tree = (await this.worktrees(repository)).find((item) => item.path === worktree);
      if (!tree) throw new Error("Worktree was removed. Choose another checkout.");
      if (tree.bare || tree.prunable || tree.locked) throw new Error("Worktree is unavailable");
      const key = `${repository}\0${tree.branch ?? ""}`;
      if (this.busyWorktrees.has(key)) throw new Error("This worktree is busy");
      this.busyWorktrees.add(key);
      try {
        const identity = await this.deps.worktrees.launchIdentity(repository, worktree);
        if (run !== "shell" && !(await this.confirmAgentLaunch(worktree, confirm))) return;
        if (run !== "shell") {
          const scan = await this.scanAgents(false);
          if (
            run === "codex" &&
            this.hooksEnabled &&
            !this.acknowledged &&
            scan.agents.some((agent) => agent.id === "codex" && agent.hooks)
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
          try {
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
            );
          } catch (error) {
            if (replacement) this.track(replacement.id).exitCode = -1;
            this.deps.onChange?.();
            throw error;
          }
        } else {
          if ((await this.deps.worktrees.launchIdentity(repository, worktree)) !== identity)
            throw new Error("Worktree has changed. Select it and try again.");
          const windows = process.platform === "win32";
          const id = await this.deps.terminals.create({
            command: windows ? "powershell.exe" : process.env["SHELL"] || "/bin/bash",
            args: windows ? ["-NoLogo"] : ["-l"],
            shellIntegration: true,
            cwd: worktree,
            cols: 80,
            rows: 24,
          });
          this.launched.set(id, {
            id,
            kind: "shell",
            agent: "shell",
            repository,
            worktree,
            branch: tree.branch,
            attention: "evaluator",
            state: null,
          });
          this.track(id);
          this.persist();
          this.refresh();
        }
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
      (source === "hook" || !this.claudeCompletionHook(id))
    )
      terminal.completedTurn = event.turn;
    if (phase === "exited" && event.from === "working") terminal.interrupted = true;
  }

  private claudeCompletionHook(id: string): boolean {
    const entry = this.launched.get(id);
    return entry?.agent === "claude" && entry.attention === "hooks";
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
            : (phase === "idle" || phase === "starting") &&
                (state.state === "working" || state.state === "checking")
              ? "quiet_ok"
              : state.state;
    terminal.state = {
      id,
      ...state,
      ...(terminal.execution ? { execution: terminal.execution.snapshot() } : {}),
      state: resolved,
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
    // A reply or dismissal since this evaluation began makes its evidence stale.
    const stale = () =>
      this.closed ||
      this.terminals.get(id) !== terminal ||
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
    const previousState = terminal.state;
    const checking = setTimeout(() => {
      if (!stale() && terminal.exitCode === undefined && !terminal.hook) {
        this.publish(id, terminal, {
          verdictId: null,
          state: "checking",
          reason: "Evaluating terminal output",
          signal: "evaluation:pending",
          confidence: 1,
        });
      }
    }, 150);
    let record: VerdictRecord;
    try {
      record = await this.deps.verdicts.classify({
        terminalId: id,
        tail,
        ...this.agentInput(id, terminal),
        ...(terminal.hook && !terminal.permissionProgress ? { hook: terminal.hook } : {}),
        ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
      });
    } finally {
      clearTimeout(checking);
      if (
        !this.closed &&
        this.terminals.get(id) === terminal &&
        terminal.state?.state === "checking"
      ) {
        if (previousState && !stale()) {
          terminal.state = previousState;
          this.deps.onState(previousState);
        } else {
          this.publish(id, terminal, {
            verdictId: null,
            state: "working",
            reason: "No completion or input request detected",
            signal: "evaluation:finished",
            confidence: 0.25,
          });
        }
      }
    }
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
        this.claudeCompletionHook(id) &&
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
    if (signal.action === "working") {
      this.track(id).generation++;
      this.transition(id, "working", "hook");
      return Promise.resolve();
    }
    if (signal.action === "needs_input") {
      delete this.track(id).permissionReply;
      delete this.track(id).permissionProgress;
      delete this.track(id).dismissedAttention;
      this.track(id).hook = { terminalId: id, action: signal.action, signal: signal.signal };
      this.transition(id, "blocked", "hook");
    } else if (signal.signal !== "claude:idle_prompt") {
      const terminal = this.track(id);
      const turn = terminal.execution?.snapshot().turn;
      if (turn && signal.signal === "claude:Stop") terminal.completedTurn = turn;
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
    const current = this.track(id);
    if (current.execution) this.transition(id, "exited", "exit");
    return this.enqueue(id, async (terminal) => {
      if (terminal.exitCode !== undefined) return;
      terminal.exitCode = code;
      delete terminal.hook;
      await this.evaluate(id, terminal);
    });
  }

  /** The terminal was killed and removed from the board. */
  removed(id: string): void {
    this.agents.release(id);
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
    this.executionListeners.clear();
    this.deps.watcher?.dispose();
    for (const id of this.terminals.keys()) this.deps.verdicts.forget(id);
    this.agents.dispose();
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
      }
    }
  }
}
