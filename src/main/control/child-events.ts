/** Shared metadata invalidation stream. No PTYs, views, polling or per-listener timers. */
export class ChildEvents {
  private readonly listeners = new Set<{ notify: () => void; deadline?: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queued = false;

  subscribe(notify: () => void, deadline?: number): () => void {
    const entry = { notify, ...(deadline === undefined ? {} : { deadline }) };
    this.listeners.add(entry);
    this.schedule();
    return () => {
      this.listeners.delete(entry);
      this.schedule();
    };
  }

  /** Coalesce synchronous changes and observe the completed metadata mutation. */
  publish(): void {
    if (this.queued || this.listeners.size === 0) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      for (const entry of [...this.listeners]) entry.notify();
    });
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const deadline = Math.min(...[...this.listeners].map((entry) => entry.deadline ?? Infinity));
    if (!Number.isFinite(deadline)) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        for (const entry of [...this.listeners]) {
          if (entry.deadline !== undefined && entry.deadline <= Date.now()) {
            delete entry.deadline;
            entry.notify();
          }
        }
        this.schedule();
      },
      Math.max(0, deadline - Date.now()),
    );
    this.timer.unref();
  }
}
