import { createHash } from "node:crypto";
import { AgentExecution } from "../agents/execution";
import { builtinAgent } from "../../shared/providers/catalog";
import { detectAgent, ruleRegion } from "../evaluator/agent-rules";
import { waitingState } from "./waiting-state";
import type { V2HookRuntime } from "../../shared/v2-hooks";
import type { ExecutionPhase, ExecutionSource, ExecutionTransition } from "../../shared/execution";
import type { AgentEvidence } from "../../shared/agent-detection";
import type { ShellState } from "../../shared/desktop";
import type { EvaluationInput, VerdictAction, VerdictRecord } from "../../shared/evaluator";
import type { HookSignal } from "../../shared/hooks";
import type { TerminalState, WorkspaceTerminal } from "../../shared/workspace";

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

export interface ExecutionOwnerDependencies {
  terminal: (
    id: string,
  ) => Readonly<Pick<WorkspaceTerminal, "kind" | "agent" | "attention">> | undefined;
  tail: (id: string, lines: number) => Promise<string[]>;
  verdicts: {
    classify: (input: EvaluationInput) => Promise<VerdictRecord>;
    commit: (record: VerdictRecord) => Promise<void>;
    forget: (id: string) => void;
    recordAction: (id: string, verdictId: string, action: VerdictAction) => Promise<void>;
  };
  enqueue: (id: string, work: () => Promise<void>) => Promise<void>;
  closed: () => boolean;
  refresh: () => void;
  recheck: (id: string) => void;
  exited: (id: string) => void;
  publishChildEvents: () => void;
  waitingOn: (id: string) => number;
  unreadAt: (id: string) => number | undefined;
  reviewReason?: (id: string) => string | undefined;
  onExecution?: (event: ExecutionTransition) => void;
  onState: (state: TerminalState) => void;
  now: () => number;
}

/** Main-owned invocation state, local evaluation and verdict publication. */
export class ExecutionOwner {
  private launchSequence = 0;
  private readonly executionListeners = new Set<(event: ExecutionTransition) => void>();
  private readonly terminals = new Map<string, Terminal>();
  constructor(private readonly deps: ExecutionOwnerDependencies) {}

  has(id: string): boolean {
    return this.terminals.has(id);
  }
  ensure(id: string): void {
    this.track(id);
  }
  markExited(id: string, code: number): void {
    this.track(id).exitCode = code;
  }
  attachHooks(id: string, runtime?: V2HookRuntime): void {
    this.execution(id);
    if (runtime) this.track(id).v2Hooks = runtime;
  }
  launched(id: string): void {
    const terminal = this.track(id);
    const execution = this.execution(id);
    if (terminal.exitCode !== undefined) execution.transition("exited", "exit");
    else if (terminal.evidence) void this.evidence(id, terminal.evidence, true);
  }
  view(id: string) {
    const terminal = this.terminals.get(id);
    return {
      execution: terminal?.execution?.snapshot(),
      exitCode: terminal?.exitCode,
      foregroundProgram: terminal?.foregroundProgram,
      outputRevision: terminal?.outputVersion ?? 0,
      inputRevision: terminal?.inputVersion ?? 0,
    };
  }

  currentState(id: string): TerminalState | null {
    const terminal = this.terminals.get(id);
    const state = terminal?.state;
    const current = waitingState(
      id,
      terminal?.hook?.action === "needs_input" && state
        ? { ...state, attentionKind: "permission" }
        : (state ?? null),
      terminal?.execution?.snapshot(),
      this.deps.waitingOn(id),
    );
    // The orchestrator's own attention (a permission prompt, a question) keeps its
    // reason and verdict; the unread reminder only raises otherwise-quiet states.
    if (current?.state === "needs_input") return current;
    const unreadAt = this.deps.unreadAt(id);
    if (unreadAt !== undefined)
      return {
        id,
        execution: terminal?.execution?.snapshot(),
        verdictId: null,
        state: "needs_input",
        reason: this.deps.reviewReason?.(id) ?? "Child report unread",
        signal: "orchestration:unread",
        confidence: 1,
        timestamp: unreadAt,
        attentionKind: "unknown",
      };
    return current;
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
        this.deps.refresh();
        const entry = this.deps.terminal(id);
        if (entry?.kind === "agent" && event.to === "idle") this.deps.recheck(id);
        for (const listener of this.executionListeners) listener(event);
      },
      this.deps.now,
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
    const entry = this.deps.terminal(id);
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
      timestamp: this.deps.now(),
    };
    this.deps.publishChildEvents();
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
      this.deps.closed() ||
      this.terminals.get(id) !== terminal ||
      (terminal.exitCode === undefined && (terminal.inputVersion ?? 0) !== inputVersion) ||
      (generation !== undefined && generation !== terminal.generation) ||
      (terminal.exitCode === undefined &&
        (!terminal.hook || terminal.permissionProgress) &&
        outputVersion !== terminal.outputVersion);
    if (stale()) return;
    let tail: string[] = [];
    try {
      tail = await this.deps.tail(id, 40);
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
    this.deps.refresh();
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
      this.deps.terminal(id)?.kind === "agent" ||
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
    const agent = this.deps.terminal(id)?.agent;
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
    return this.deps.enqueue(id, async () => {
      const terminal = this.track(id);
      if (terminal.exitCode === undefined && terminal.shellRunning !== false)
        await this.evaluate(id, terminal, generation, outputVersion);
    });
  }

  /** Only signals resolved against a current per-launch hook capability reach here. */
  hook(id: string, signal: HookSignal): Promise<void> {
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
    return this.deps.enqueue(id, async () => {
      const terminal = this.track(id);
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
    const current = this.track(id);
    if (current.execution) this.transition(id, "exited", "exit");
    return this.deps.enqueue(id, async () => {
      const terminal = this.track(id);
      if (terminal.exitCode !== undefined) return;
      terminal.exitCode = code;
      // Exit metadata must be observable even if final evaluation fails.
      this.deps.publishChildEvents();
      const entry = this.deps.terminal(id);
      if (entry?.kind === "agent") this.deps.recheck(id);
      this.deps.exited(id);
      delete terminal.hook;
      await this.evaluate(id, terminal);
    });
  }

  /** Drop the invocation; pending evaluations fail their identity check. */
  reset(id: string): void {
    this.terminals.delete(id);
  }

  removed(id: string): void {
    this.reset(id);
    this.deps.verdicts.forget(id);
  }

  disposeSubscriptions(): void {
    this.executionListeners.clear();
  }

  forgetVerdicts(): void {
    for (const id of this.terminals.keys()) this.deps.verdicts.forget(id);
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
      reason: action === "replied" ? "You replied" : "Dismissed",
      signal: action === "replied" ? "user:reply" : "user:dismissed",
      confidence: 1,
    });
  }
}
