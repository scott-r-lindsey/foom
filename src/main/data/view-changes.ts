import type { DataView } from "../../shared/data-views";

/** One process-wide publication clock, including changes to nonpersistent observations. */
export class ViewChanges {
  revision = 0;
  private readonly revisions = new Map<DataView, number>();
  current(view: DataView): number {
    return this.revisions.get(view) ?? 0;
  }
  private readonly listeners = new Set<(views: ReadonlySet<DataView>, revision: number) => void>();
  publish(...views: DataView[]): void {
    const revision = ++this.revision;
    for (const view of views) this.revisions.set(view, revision);
    for (const listener of this.listeners) listener(new Set(views), revision);
  }
  subscribe(listener: (views: ReadonlySet<DataView>, revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
export const viewChanges = new ViewChanges();
