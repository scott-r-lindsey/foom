import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CleanupDialog,
  CleanupFeed,
  CleanupItem,
  CleanupProgress,
  CleanupReason,
} from "../../shared/cleanup";
import type { Worktree } from "../../shared/worktrees";

export interface CleanupCandidate {
  tree: Worktree;
  reason: CleanupReason | undefined;
  identity?: string;
  changes?: string;
}

/** Main owns the lifetime; closing a presentation only unsubscribes it. */
export class CleanupRun implements CleanupFeed {
  private readonly id = randomUUID();
  private stage: CleanupDialog["stage"] = "checking";
  private listeners = new Set<() => void>();
  private plan: readonly CleanupCandidate[] = [];
  private items: CleanupItem[] = [];
  private phase: CleanupProgress["phase"] = "fetch";
  private stopped = false;
  private total = 0;
  private done = 0;
  private error: "fetch failed" | undefined;
  private operation: Promise<void> | undefined;
  constructor(
    private readonly deps: {
      checkingCount?: number | undefined;
      fetchedAt?(): number | undefined;
      fetch(): Promise<string>;
      remove(candidate: CleanupCandidate, base: string): Promise<void>;
      branches(candidates: readonly CleanupCandidate[]): Promise<readonly string[]>;
      changed(): void;
    },
  ) {}
  get pending(): boolean {
    return this.phase !== "finished";
  }
  get removedTrees(): readonly (Worktree & { removed: true })[] {
    return this.plan.flatMap((candidate, index) =>
      this.items[index]?.state === "removed" ? [{ ...candidate.tree, removed: true as const }] : [],
    );
  }
  stop(): void {
    this.stopped = true;
    this.publish();
  }
  get active(): boolean {
    return this.stage === "run" && this.phase !== "finished";
  }
  get progress(): CleanupProgress {
    return {
      id: this.id,
      total: this.total,
      done: this.done,
      phase: this.phase,
      stopped: this.stopped,
      items: this.items.map((item) => ({ ...item })),
    };
  }
  current(): CleanupDialog {
    const progress = this.progress;
    const fetchedAt = this.deps.fetchedAt?.();
    return {
      ...(this.error ? { error: this.error } : {}),
      stage: this.stage,
      ...(this.deps.checkingCount !== undefined ? { checkingCount: this.deps.checkingCount } : {}),
      ...(fetchedAt !== undefined ? { fetchedAt } : {}),
      progress: {
        ...progress,
        items: progress.items.map(({ id, branch, state, reason, changes, omittedChanges }) => ({
          id,
          branch,
          state,
          ...(reason ? { reason } : {}),
          ...(changes ? { changes } : {}),
          ...(omittedChanges ? { omittedChanges } : {}),
        })),
      },
    };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(): void {
    this.deps.changed();
    for (const listener of this.listeners) listener();
  }
  ready(plan: readonly CleanupCandidate[]): void {
    this.plan = plan;
    this.items = plan.map(({ tree, reason, changes }, index) => ({
      id: String(index),
      path: tree.path,
      branch:
        tree.branch ??
        `${basename(tree.path)} · Detached at ${tree.head?.slice(0, 7) ?? "Unknown"}`,
      state: reason ? "kept" : "queued",
      ...(reason ? { reason } : {}),
      ...(changes
        ? {
            omittedChanges: Math.max(0, changes.split("\0").filter(Boolean).length - 50),
            changes: changes
              .split("\0")
              .filter(Boolean)
              .slice(0, 50)
              .map((entry) => (entry.length > 500 ? `${entry.slice(0, 499)}…` : entry))
              .join("\0"),
          }
        : {}),
    }));
    this.total = this.items.filter((item) => item.state === "queued").length;
    this.stage = "ready";
    this.publish();
  }
  failed(): void {
    this.error = "fetch failed";
    this.stage = "run";
    this.phase = "finished";
    this.items = this.items.map((item) =>
      item.state === "queued" ? { ...item, state: "kept", reason: "fetch failed" } : item,
    );
    this.publish();
  }
  act(): void {
    if (this.stage === "ready" && this.total > 0 && !this.stopped) {
      this.stage = "run";
      this.publish();
      this.operation = this.run();
    } else if (this.active) {
      this.stopped = true;
      this.publish();
    }
  }
  async settled(): Promise<void> {
    await this.operation;
  }
  private async run(): Promise<void> {
    let base: string;
    try {
      base = await this.deps.fetch();
    } catch {
      this.failed();
      return;
    }
    this.phase = "remove";
    this.publish();
    let next = 0;
    const removed: CleanupCandidate[] = [];
    // Detached checkouts share the existing null-branch reservation. Release it
    // after each removal and serialize only those candidates within this run.
    let detached: Promise<void> = Promise.resolve();
    const worker = async () => {
      while (!this.stopped && next < this.plan.length) {
        const index = next++;
        const candidate = this.plan[index];
        const item = this.items[index];
        if (!candidate || !item || candidate.reason) continue;
        item.state = "removing";
        this.publish();
        try {
          if (candidate.tree.branch === null) {
            const removal = detached.then(() => this.deps.remove(candidate, base));
            detached = removal.catch(() => undefined);
            await removal;
          } else await this.deps.remove(candidate, base);
          item.state = "removed";
          removed.push(candidate);
        } catch (error) {
          const reason = error instanceof KeptWorktree ? error.reason : "removal failed";
          item.state = error instanceof KeptWorktree ? "kept" : "error";
          item.reason = reason;
        }
        this.done++;
        this.publish();
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    for (const item of this.items) {
      if (item.state === "queued") {
        item.state = "kept";
        item.reason = "not started";
      }
    }
    try {
      const kept = await this.deps.branches(removed);
      for (const item of this.items) if (kept.includes(item.branch)) item.reason = "branch kept";
    } catch {
      for (const item of this.items) if (item.state === "removed") item.reason = "branch kept";
    }
    this.phase = "finished";
    this.publish();
  }
}
export class KeptWorktree extends Error {
  constructor(readonly reason: CleanupReason) {
    super(reason);
  }
}
