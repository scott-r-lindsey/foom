import type { TerminalPaste } from "../../shared/image-paste.d";

/** Preserve gesture/input order while clipboard preparation crosses IPC/SSH. */
export class TerminalInputOrder {
  private tail = Promise.resolve();
  private pending = 0;
  private bytes = 0;
  private revision = 0;
  private applying = false;
  private readonly cancellations = new Set<(reason: TerminalPaste) => void>();

  private enqueue(action: () => void | Promise<void>): Promise<void> {
    this.pending++;
    const operation = this.tail.then(action);
    this.tail = operation
      .catch(() => {
        this.cancel();
      })
      .finally(() => {
        this.pending--;
      });
    return operation;
  }
  cancel(reason: TerminalPaste = { kind: "cancelled" }): void {
    this.revision++;
    for (const cancel of this.cancellations) cancel(reason);
  }
  input(size: number, send: () => void, live: () => boolean): void {
    if (!live()) return;
    if (this.applying || this.pending === 0) {
      send();
      return;
    }
    const revision = this.revision;
    this.bytes += size;
    // Only unsent input is buffered. Failure never replays it after reconnect.
    if (this.bytes > 65536) this.cancel({ kind: "failed" });
    void this.enqueue(() => {
      this.bytes -= size;
      if (revision === this.revision && live()) send();
    }).catch(() => {});
  }
  paste(
    response: Promise<TerminalPaste>,
    apply: (result: TerminalPaste) => void,
    live: () => boolean,
  ): Promise<void> {
    let cancel: ((reason: TerminalPaste) => void) | undefined;
    const cancelled = new Promise<TerminalPaste>((resolve) => {
      cancel = resolve;
      this.cancellations.add(resolve);
    });
    // Observe rejection at the gesture, even if an earlier paste is still pending.
    const prepared = response.catch(() => ({ kind: "failed" }) as const);
    return this.enqueue(async () => {
      const result = await Promise.race([prepared, cancelled]);
      if (!live()) return;
      if (result.kind !== "text" && result.kind !== "empty") this.cancel(result);
      this.applying = true;
      try {
        apply(result);
      } finally {
        this.applying = false;
      }
    }).finally(() => {
      if (cancel) this.cancellations.delete(cancel);
    });
  }
}
