import type { DialogContent, RemovalItem, RemovalFeed } from "../../shared/confirmation";

interface Batch {
  items: RemovalItem[];
  listeners: Set<() => void>;
  selected: Set<string>;
  controller: AbortController;
  result: Promise<boolean>;
}

/** Review together; each caller resumes its own independently revalidated removal. */
export class RemovalReview {
  private readonly batches = new Map<string, Batch>();
  constructor(
    private readonly dialog: (content: DialogContent, signal?: AbortSignal) => Promise<boolean>,
  ) {}

  async request(group: string, item: RemovalItem, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    let batch = this.batches.get(group);
    if (!batch) {
      const current: Batch = {
        items: [],
        listeners: new Set(),
        selected: new Set(),
        controller: new AbortController(),
        result: Promise.resolve(false),
      };
      batch = current;
      this.batches.set(group, current);
      const feed: RemovalFeed = {
        current: () => [...current.items],
        subscribe: (listener) => {
          current.listeners.add(listener);
          return () => current.listeners.delete(listener);
        },
        select: (ids) => {
          current.selected = new Set(ids);
          if (this.batches.get(group) === current) this.batches.delete(group);
        },
      };
      current.result = this.dialog(
        { title: "Remove worktrees?", glyph: "branch", accept: "Approve all", removalFeed: feed },
        current.controller.signal,
      ).finally(() => {
        if (this.batches.get(group) === current) this.batches.delete(group);
      });
    }
    const current = batch;
    const cancel = () => {
      if (this.batches.get(group) === current) this.batches.delete(group);
      current.controller.abort();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    current.items.push(item);
    for (const listener of current.listeners) listener();
    try {
      return (
        (await current.result) &&
        !current.controller.signal.aborted &&
        !signal?.aborted &&
        current.selected.has(item.id)
      );
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
}
