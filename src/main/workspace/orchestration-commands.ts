import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { AgentEvidence } from "../../shared/agent-detection";
import type { AgentId } from "../../shared/agents";
import type { ConfirmWorkspace } from "../../shared/confirmation";
import type { ShellState } from "../../shared/desktop";
import type { VerdictAction } from "../../shared/evaluator";
import type { HookSignal } from "../../shared/hooks";
import type { WorkspaceTerminal } from "../../shared/workspace";
import { AGENTS } from "../agents/agent-list";
import { conversationId } from "../agents/conversation";
import { UncertainEffect } from "../control/orchestration";
import type { ExecutionEventsContext, OrchestrationCommandsContext } from "./feature-context";

export async function auditHuman(
  this: OrchestrationCommandsContext,
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

export function orchestrationView(
  this: OrchestrationCommandsContext,
  id: string,
): Pick<WorkspaceTerminal, "orchestration" | "handoff"> {
  const view = this.orchestration.view(id);
  const handoff = this.orchestration.handoffs.latest(id);
  return { ...(view ? { orchestration: view } : {}), ...(handoff ? { handoff } : {}) };
}

export async function makeOrchestrator(
  this: OrchestrationCommandsContext,
  id: string,
  confirm: ConfirmWorkspace,
): Promise<void> {
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
    if (view?.role === "child" && !view.takenOver) throw new Error("Take over this session first");
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

export async function revokeOrchestrator(
  this: OrchestrationCommandsContext,
  id: string,
): Promise<void> {
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

export async function createChildWorktree(
  this: OrchestrationCommandsContext,
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

export async function launchChild(
  this: OrchestrationCommandsContext,
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

export function enqueue(
  this: ExecutionEventsContext,
  id: string,
  work: () => Promise<void>,
): Promise<void> {
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

export function foreground(this: ExecutionEventsContext, id: string, name: string): void {
  this.executionOwner.foreground(id, name);
}

export function shellState(this: ExecutionEventsContext, id: string, state: ShellState): void {
  this.executionOwner.shellState(id, state);
}

export function output(this: ExecutionEventsContext, id: string): void {
  this.probes?.output(id);
  this.executionOwner.output(id);
}

export function evidence(
  this: ExecutionEventsContext,
  id: string,
  evidence: AgentEvidence,
  initial = false,
): Promise<void> {
  if (this.probeIds.has(id) || this.launched.get(id)?.probe)
    return this.probes?.quiet(id) ?? Promise.resolve();
  return this.executionOwner.evidence(id, evidence, initial);
}

export function quiet(this: ExecutionEventsContext, id: string): Promise<void> {
  if (this.probeIds.has(id) || this.launched.get(id)?.probe)
    return this.probes?.quiet(id) ?? Promise.resolve();
  return this.executionOwner.quiet(id);
}

export function hook(this: ExecutionEventsContext, signal: HookSignal): Promise<void> {
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
  return this.executionOwner.hook(id, signal);
}

export function exited(this: ExecutionEventsContext, id: string, code: number): Promise<void> {
  this.revokeConfig(id);
  void this.probes?.exited(id).catch(() => undefined);
  this.agents.release(id);
  this.orchestration.exited(id);
  return this.executionOwner.exited(id, code);
}

export function removed(this: ExecutionEventsContext, id: string): void {
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

export function input(this: ExecutionEventsContext, id: string): void {
  this.probes?.input(id);
  this.executionOwner.input(id);
}

export function feedback(
  this: ExecutionEventsContext,
  id: string,
  verdictId: string | null,
  action: VerdictAction,
): Promise<void> {
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
