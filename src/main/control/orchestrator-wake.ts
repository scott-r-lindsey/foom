import type { WakePolicy, WakeInput } from "../../shared/agent-wake";
import { randomUUID } from "node:crypto";
import { wakeLine } from "../../shared/agent-wake";
import type { Operations } from "./operations";
import type { Operation, Principal } from "./types";
import type { OrchestrationHost } from "./orchestration.d";

/** Bounded per-parent event queue. Screens and authority are rechecked on every attempt. */
export class OrchestratorWake {
  private enabled = false;
  private interval = 180000;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly bindings = new Map<string, { actor: Principal; operations: Operations }>();
  private readonly pending = new Map<string, Map<string, number>>();
  private readonly attempted = new Map<string, number>();
  private readonly last = new Map<string, number>();
  private readonly busy = new Set<string>();
  constructor(
    private readonly host: Pick<OrchestrationHost, "wake" | "terminals">,
    private readonly valid: (actor: Principal, childId?: string) => boolean,
    private readonly note: (actor: Principal, record: Operation) => void,
    private readonly now: () => number = Date.now,
  ) {}
  configure(enabled: boolean, minutes: number): void {
    this.enabled = enabled;
    this.interval = minutes * 60000;
    if (!enabled) this.pending.clear();
    this.sync();
  }
  bind(actor: Principal, operations: Operations): void {
    if (this.bindings.get(actor.terminalId)?.actor !== actor) {
      this.pending.delete(actor.terminalId);
      this.last.delete(actor.terminalId);
      this.attempted.delete(actor.terminalId);
    }
    if (actor.role !== "orchestrator") {
      this.bindings.delete(actor.terminalId);
      return;
    }
    this.bindings.set(actor.terminalId, { actor, operations });
  }
  event(parentId: string, childId: string): void {
    if (!this.enabled || this.disposed) return;
    let queue = this.pending.get(parentId);
    if (!queue) {
      queue = new Map();
      this.pending.set(parentId, queue);
    }
    queue.set(childId, (queue.get(childId) ?? 0) + 1);
    queueMicrotask(() => {
      this.sync();
    });
  }
  read(parentId: string, childId: string): void {
    this.pending.get(parentId)?.delete(childId);
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.pending.clear();
    this.bindings.clear();
  }
  sync(): void {
    clearTimeout(this.timer);
    if (this.disposed || !this.enabled) return;
    for (const [id, queue] of this.pending) {
      const run = this.bindings.get(id);
      if (!run || !this.valid(run.actor)) {
        this.pending.delete(id);
        continue;
      }
      for (const child of queue.keys()) if (!this.valid(run.actor, child)) queue.delete(child);
      if (
        this.now() - (this.attempted.get(id) ?? -Infinity) < 2000 ||
        !queue.size ||
        this.busy.has(id) ||
        this.now() - (this.last.get(id) ?? -Infinity) < this.interval
      )
        continue;
      this.attempted.set(id, this.now());
      this.busy.add(id);
      void this.deliver(id, queue, run).finally(() => {
        this.busy.delete(id);
        this.sync();
      });
    }
    if ([...this.pending.values()].some((queue) => queue.size)) {
      this.timer = setTimeout(() => {
        this.sync();
      }, 2000);
      this.timer.unref();
    }
  }
  private async deliver(
    id: string,
    queue: Map<string, number>,
    run: { actor: Principal; operations: Operations },
  ): Promise<void> {
    const { actor, operations } = run;
    const batch = [...queue];
    const rows = this.host.terminals();
    const line = wakeLine(
      batch.map(([id]) => rows.find((row) => row.id === id)?.branch ?? "child"),
    );
    let operation: Operation | undefined;
    const valid = () =>
      !this.disposed &&
      this.enabled &&
      this.bindings.get(id) === run &&
      this.valid(actor) &&
      batch.some(([child, version]) => queue.get(child) === version && this.valid(actor, child));
    try {
      const result = await this.host.wake?.(id, line, valid, async () => {
        operation = await operations.begin(actor, "wake", randomUUID(), line, id);
        this.note(actor, operation);
      });
      if (operation) {
        this.last.set(id, this.now());
        this.note(
          actor,
          await operations.finish(
            actor,
            operation.operationId,
            result === "sent" ? "succeeded" : "cancelled",
            result === "sent" ? "completed" : "refused",
            id,
          ),
        );
      }
      if (result === "sent")
        for (const [child, version] of batch) if (queue.get(child) === version) queue.delete(child);
    } catch {
      // A lost write acknowledgement is not safely retryable; retain an audit record.
      if (operation) {
        for (const [child, version] of batch) if (queue.get(child) === version) queue.delete(child);
        this.last.set(id, this.now());
        await operations
          .finish(actor, operation.operationId, "indeterminate", "uncertain", id)
          .then((record) => {
            this.note(actor, record);
          })
          .catch(() => {});
      }
    }
  }
}

/** Main rechecks hook/focus/authority around every asynchronous host operation. */
export async function deliverWake(
  policy: WakePolicy | undefined,
  write: ((input: WakeInput) => Promise<boolean>) | undefined,
  allowed: () => boolean,
  line: string,
  intent: () => Promise<void>,
): Promise<"sent" | "queued"> {
  if (!policy || !write || !allowed()) return "queued";
  if (!(await write({ policy, step: "check", line })) || !allowed()) return "queued";
  await intent();
  if (!allowed() || !(await write({ policy, step: "cancel", line }))) return "queued";
  await new Promise((resolve) => {
    setTimeout(resolve, 150);
  });
  if (!allowed() || !(await write({ policy, step: "submit", line }))) return "queued";
  return "sent";
}
