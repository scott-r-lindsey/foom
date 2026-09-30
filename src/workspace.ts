import { AgentService } from "./agents";
import { prepareHookLaunch } from "./hook-launch";
import type { HookRegistrar } from "./hook-launch";
import type { AgentHooks, AgentId } from "./shared/agents";
import type { TerminalSpec } from "./shared/desktop";
import type { EvaluationInput, VerdictAction, VerdictRecord } from "./shared/evaluator";
import type { HookSignal } from "./shared/hooks";
import type { Repository, Worktree } from "./shared/worktrees";
import type {
  AgentReport,
  LaunchRequest,
  TerminalState,
  WorkspaceSnapshot,
  WorkspaceTerminal,
} from "./shared/workspace";
import type { WorktreeService } from "./worktrees";

type Agents = Pick<AgentService, "scan" | "launch" | "release" | "dispose">;
type Terminal = {
  exitCode?: number;
  hook?: HookSignal;
  state: TerminalState | null;
  /** Bumped by replies and dismissals; evaluations that began earlier are discarded. */
  generation: number;
};

export interface WorkspaceDependencies {
  worktrees: Pick<
    WorktreeService,
    "listRepositories" | "addRepository" | "listWorktrees" | "createWorktree"
  >;
  terminals: {
    create(spec: TerminalSpec): Promise<string>;
    tail(id: string, lines: number): Promise<string[]>;
  };
  verdicts: {
    classify(input: EvaluationInput): Promise<VerdictRecord>;
    commit(record: VerdictRecord): Promise<void>;
    recordAction(terminalId: string, verdictId: string, action: VerdictAction): Promise<void>;
  };
  /** Started on the first launch that attaches hooks, then reused. */
  receiver: () => Promise<HookRegistrar & { close(): Promise<void> }>;
  onState(state: TerminalState): void;
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
  private readonly now: () => number;

  constructor(private readonly deps: WorkspaceDependencies) {
    this.now = deps.now ?? Date.now;
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

  snapshot(): WorkspaceSnapshot {
    return {
      repositories: this.deps.worktrees.listRepositories(),
      terminals: [...this.launched.values()].map((entry) => ({
        ...entry,
        state: this.terminals.get(entry.id)?.state ?? null,
      })),
    };
  }

  addRepository(path: string): Promise<Repository> {
    return this.deps.worktrees.addRepository(path);
  }

  private known(repository: string): void {
    if (!this.deps.worktrees.listRepositories().some((entry) => entry.path === repository))
      throw new Error("Repository has not been added");
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
    this.known(repository);
    const path = await this.deps.worktrees.createWorktree(repository, branch, { location });
    const created = (await this.deps.worktrees.listWorktrees(repository)).find(
      (tree) => tree.path === path,
    );
    if (!created) throw new Error("Created worktree is missing");
    return created;
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
  async launch(request: LaunchRequest): Promise<{ id: string; attention: "hooks" | "evaluator" }> {
    if (this.closed) throw new Error("Workspace is closed");
    this.known(request.repository);
    // Scan once so launches don't each probe the login shell.
    await this.scanAgents(false);
    // Look up the branch before spawning, so nothing can fail between spawn and tracking.
    const tree = (await this.deps.worktrees.listWorktrees(request.repository)).find(
      (entry) => entry.path === request.worktree,
    );
    const result = await this.agents.launch(request);
    this.launched.set(result.id, {
      id: result.id,
      kind: "agent",
      agent: request.agent,
      repository: request.repository,
      worktree: request.worktree,
      branch: tree?.branch ?? null,
      attention: result.attention,
      state: null,
    });
    this.track(result.id);
    return result;
  }

  private track(id: string): Terminal {
    let terminal = this.terminals.get(id);
    if (!terminal) {
      terminal = { state: null, generation: 0 };
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

  private async evaluate(id: string, terminal: Terminal, generation?: number): Promise<void> {
    let tail: string[] = [];
    try {
      tail = await this.deps.terminals.tail(id, 40);
    } catch {
      // A failed host has no screen. Exit codes and hooks still decide.
    }
    const record = await this.deps.verdicts.classify({
      terminalId: id,
      tail,
      ...(terminal.hook ? { hook: terminal.hook } : {}),
      ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
    });
    // A reply or dismissal since this evaluation began makes its evidence stale.
    const stale = () => generation !== undefined && generation !== terminal.generation;
    if (stale()) return;
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

  /** Output went quiet. Live terminals only; an exit verdict is final. */
  quiet(id: string): Promise<void> {
    const { generation } = this.track(id);
    return this.enqueue(id, async (terminal) => {
      if (terminal.exitCode === undefined) await this.evaluate(id, terminal, generation);
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
    this.agents.dispose();
    this.hookKeys.clear();
    const receiver = this.receiver;
    this.receiver = undefined;
    if (receiver) await (await receiver.catch(() => undefined))?.close();
  }
}
