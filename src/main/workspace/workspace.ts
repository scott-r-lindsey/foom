import type { InventoryWatch } from "./inventory-watch";
import type { ConfirmWorkspace } from "../../shared/confirmation";
import { EMPTY_AGENT_ARGUMENTS, hasBypassArgument } from "../agents/default-arguments";
import { detectAgent } from "../evaluator/agent-rules";
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
  evidence?: AgentEvidence;
  shellRunning?: boolean;
  exitCode?: number;
  hook?: HookSignal;
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
  /** Started on the first launch that attaches hooks, then reused. */
  receiver: () => Promise<HookRegistrar & { close(): Promise<void> }>;
  onState(state: TerminalState): void;
  onChange?(): void;
  watcher?: Pick<InventoryWatch, "sync" | "dispose">;
  acknowledgeCodex(): Promise<void>;
  agents?: (prepare: (agent: AgentId) => Promise<AgentHooks>) => Agents;
  now?: () => number;
}

/**
 * Main-process integration: launches agents into managed worktrees, turns quiet events,
 * exits and hook signals into verdicts, and reports state. Terminal IDs are the only
 * identifiers crossing into evaluation; agent text never does.
 */
export class Workspace {
  private readonly agents: Agents;
  private readonly launched = new Map<string, WorkspaceTerminal>();
  private readonly terminals = new Map<string, Terminal>();
  private readonly hookKeys = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();
  private receiver: ReturnType<WorkspaceDependencies["receiver"]> | undefined;
  private scanned: ReturnType<Agents["scan"]> | undefined;
  private closed = false;
  private location: "root" | "adjacent" = "root";
  private acknowledged = false;
  private hooksEnabled = true;
  private defaultArguments = EMPTY_AGENT_ARGUMENTS;
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
        if (terminalId) this.hookKeys.set(key, terminalId);
        else this.hookKeys.delete(key);
      });
    };
    this.agents = deps.agents
      ? deps.agents(prepare)
      : new AgentService(deps.worktrees, deps.terminals, prepare);
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

  snapshot(): WorkspaceSnapshot {
    return {
      repositories: this.deps.worktrees.listRepositories(),
      terminals: [...this.launched.values()].map((entry) => ({
        ...entry,
        state: this.terminals.get(entry.id)?.state ?? null,
        exited: this.terminals.get(entry.id)?.exitCode !== undefined,
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
        mainCheckout,
        sharedCheckout,
        ...(checkoutIdentity !== undefined ? { checkoutIdentity } : {}),
      });
      this.launched.set(result.id, {
        id: result.id,
        kind: "agent",
        agent: request.agent,
        repository: request.repository,
        worktree: request.worktree,
        branch: tree?.branch ?? null,
        attention: result.attention,
        bypass: hasBypassArgument(request.agent, defaultArguments),
        state: null,
      });
      this.track(result.id);
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
        await this.deps.terminals.stop(item.id);
        await this.exited(item.id, -1);
      }
      if (
        (await this.deps.worktrees.changes(entry.repository, entry.worktree, identity)) !== changes
      )
        throw new Error("Worktree changes have changed. Review them and try again.");
      await this.deps.worktrees.removeWorktree(
        entry.repository,
        entry.worktree,
        changes.length > 0,
        identity,
      );
      for (const item of entries) {
        await this.deps.terminals.kill(item.id);
        this.removed(item.id);
      }
      return true;
    } finally {
      this.busyWorktrees.delete(key);
    }
  }

  async sidebarInventory(): Promise<SidebarInventory> {
    return {
      repositories: await Promise.all(
        this.deps.worktrees.listRepositories().map(async (repository) => ({
          ...repository,
          worktrees: await this.worktrees(repository.path),
        })),
      ),
      shell:
        process.platform === "win32"
          ? "powershell.exe"
          : basename(process.env["SHELL"] || "/bin/bash"),
    };
  }

  async sidebarCommand(command: SidebarCommand, confirm: ConfirmWorkspace): Promise<void> {
    if (this.closed) throw new Error("Workspace is closed");
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
      await this.deps.terminals.kill(command.id);
      this.removed(command.id);
      return;
    }
    this.known(command.repository);
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
          );
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
          this.refresh();
        }
      } finally {
        this.busyWorktrees.delete(key);
      }
    });
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
    terminal.state = { id, ...state, timestamp: this.now() };
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
        !terminal.hook &&
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
        ...(terminal.hook ? { hook: terminal.hook } : {}),
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
    if (
      terminal.state?.verdictId &&
      terminal.state.state === record.verdict.state &&
      terminal.state.signal === record.verdict.signal
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
  evidence(id: string, evidence: AgentEvidence): Promise<void> {
    const terminal = this.track(id);
    const previousEvidence = terminal.evidence ?? { title: "", progress: null };
    terminal.evidence = evidence;
    const { agent } = this.agentInput(id, terminal);
    // Unknown metadata and progress-only updates are not quiet signals. Keep them
    // for the next real quiet event rather than submitting an actively changing tail.
    if (previousEvidence.title === evidence.title || !agent) return Promise.resolve();
    const previous = detectAgent(agent, previousEvidence, []);
    const next = detectAgent(agent, evidence, []);
    if (!next || (previous?.id === next.id && previous.state === next.state))
      return Promise.resolve();
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
    // A bound key means the terminal exists, even if launch() hasn't returned yet.
    const { generation } = this.track(id);
    return this.enqueue(id, async (terminal) => {
      // A reply since the hook fired already answered it.
      if (terminal.exitCode !== undefined || terminal.generation !== generation) return;
      // A permission request stays in force until the user replies or dismisses it;
      // completion hooks only request classification.
      if (signal.action === "needs_input") terminal.hook = { ...signal, terminalId: id };
      await this.evaluate(id, terminal, generation);
    });
  }

  /** Exit verdicts ignore replies: the process is gone, so its exit always stands. */
  exited(id: string, code: number): Promise<void> {
    this.agents.release(id);
    this.track(id);
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
    this.terminals.delete(id);
    this.deps.verdicts.forget(id);
    this.refresh();
  }

  /**
   * The user typed into the terminal (terminal-generated reports are filtered out
   * before this). Pending evaluations and permission hooks are now out of date, and
   * the first keystroke after a request for input counts as the reply.
   */
  input(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    terminal.generation += 1;
    delete terminal.hook;
    const state = terminal.state;
    if (state?.state !== "needs_input") return;
    this.clear(id, terminal, "replied");
    if (state.verdictId)
      void this.deps.verdicts
        .recordAction(id, state.verdictId, "replied")
        .catch((error: unknown) => {
          console.error("Unable to record reply:", error);
        });
  }

  /** A null `verdictId` refers to a current verdict that couldn't be stored. */
  async feedback(id: string, verdictId: string | null, action: VerdictAction): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error("Unknown terminal");
    const current = () => terminal.state !== null && terminal.state.verdictId === verdictId;
    if (verdictId !== null) await this.deps.verdicts.recordAction(id, verdictId, action);
    else if (!current() || terminal.state?.signal.startsWith("user:"))
      throw new Error("Invalid verdict feedback");
    // A newer verdict may have arrived while the action was being recorded.
    if (action === "ignored" || !current()) return;
    terminal.generation += 1;
    delete terminal.hook;
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
    this.deps.watcher?.dispose();
    for (const id of this.terminals.keys()) this.deps.verdicts.forget(id);
    this.agents.dispose();
    this.hookKeys.clear();
    const receiver = this.receiver;
    this.receiver = undefined;
    if (receiver) await (await receiver.catch(() => undefined))?.close();
  }
}
