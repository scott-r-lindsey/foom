/** A stalled probe asks its driver for help, never the person watching its tile. */
export const PROBE_WAITING_MS = 60_000;
type Entry = {
  owner: string;
  blocked: boolean;
  waiting?: number;
  timer?: ReturnType<typeof setTimeout>;
};
export class ProbeAttention {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly changed: () => void,
    private readonly delay = PROBE_WAITING_MS,
    private readonly now = Date.now,
  ) {}
  add(id: string, owner: string): void {
    this.entries.set(id, { owner, blocked: false });
  }
  observe(id: string, blocked: boolean): void {
    const entry = this.entries.get(id);
    if (!entry || entry.blocked === blocked) return;
    this.input(id);
    entry.blocked = blocked;
    if (blocked)
      entry.timer = setTimeout(() => {
        delete entry.timer;
        entry.waiting = this.now();
        this.changed();
      }, this.delay);
  }
  input(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    delete entry.timer;
    entry.blocked = false;
    if (entry.waiting !== undefined) {
      delete entry.waiting;
      this.changed();
    }
  }
  waitingAt(owner: string): number | undefined {
    return [...this.entries.values()].find((entry) => entry.owner === owner)?.waiting;
  }
  dismiss(owner: string): void {
    for (const entry of this.entries.values())
      if (entry.owner === owner) {
        clearTimeout(entry.timer);
        delete entry.timer;
        if (entry.waiting !== undefined) {
          delete entry.waiting;
          this.changed();
        }
      }
  }
  remove(id: string): void {
    this.input(id);
    this.entries.delete(id);
  }
}
