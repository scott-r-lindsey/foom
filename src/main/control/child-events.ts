import type { ExecutionSnapshot } from "../../shared/execution";
import type { HandoffMetadata } from "../../shared/handoff";
import type { PullRequest } from "./forge.d";

export interface ChildObservation {
  id: string;
  parentId: string;
  execution?: ExecutionSnapshot | undefined;
  exited: boolean;
  handoff?: HandoffMetadata | undefined;
  pullRequest?: PullRequest | undefined;
}
interface Entry {
  observation: ChildObservation;
  reportTurn: number | undefined;
  unreadAt: number | undefined;
}

/** Shared child-event cursor. Output and evaluator revisions are deliberately absent. */
export class ChildEvents {
  private readonly entries = new Map<string, Entry>();
  private minutes = 5;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly changed: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  configure(minutes: number): boolean {
    const changed = this.minutes !== minutes;
    this.minutes = minutes;
    this.schedule();
    return changed;
  }

  sync(observations: readonly ChildObservation[]): void {
    const live = new Set(observations.map((row) => row.id));
    for (const id of this.entries.keys()) if (!live.has(id)) this.entries.delete(id);
    for (const row of observations) {
      let entry = this.entries.get(row.id);
      if (entry?.observation.parentId !== row.parentId) {
        entry = {
          observation: {
            ...row,
            handoff: undefined,
            pullRequest: undefined,
            exited: false,
            execution: undefined,
          },
          reportTurn: undefined,
          unreadAt: undefined,
        };
        this.entries.set(row.id, entry);
      }
      const old = entry.observation;
      const report = row.handoff !== undefined && row.handoff.seq !== old.handoff?.seq;
      if (report) entry.reportTurn = row.execution?.turn;
      const idle =
        row.execution?.phase === "idle" &&
        (old.execution?.phase !== "idle" ||
          old.execution.turn !== row.execution.turn ||
          old.execution.launch !== row.execution.launch);
      const exited = row.exited && !old.exited;
      const pr = row.pullRequest;
      const previous = old.pullRequest;
      const forge =
        pr !== undefined &&
        (pr.requiredChecks !== previous?.requiredChecks ||
          (pr.state !== "OPEN" && pr.state !== previous.state));
      if (
        report ||
        forge ||
        ((idle || exited) && (!row.handoff || entry.reportTurn !== row.execution?.turn))
      )
        entry.unreadAt ??= this.now();
      entry.observation = { ...row, pullRequest: pr ?? previous };
    }
    this.schedule();
  }

  read(parentId: string, childId?: string): boolean {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (entry.observation.parentId === parentId && (childId === undefined || childId === id)) {
        changed ||= entry.unreadAt !== undefined;
        entry.unreadAt = undefined;
      }
    }
    this.schedule();
    return changed;
  }

  overdue(parentId: string): number | undefined {
    if (this.minutes === 0) return undefined;
    const times = [...this.entries.values()]
      .filter((entry) => entry.observation.parentId === parentId)
      .flatMap((entry) => (entry.unreadAt === undefined ? [] : [entry.unreadAt]));
    const first = Math.min(...times);
    return first + this.minutes * 60000 <= this.now() ? first : undefined;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.entries.clear();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.minutes === 0) return;
    const now = this.now();
    const due = Math.min(
      ...[...this.entries.values()].flatMap((entry) => {
        const deadline = entry.unreadAt === undefined ? 0 : entry.unreadAt + this.minutes * 60000;
        return deadline > now ? [deadline] : [];
      }),
    );
    if (Number.isFinite(due)) {
      this.timer = setTimeout(() => {
        this.changed();
        this.schedule();
      }, due - now);
      this.timer.unref();
    }
  }
}
