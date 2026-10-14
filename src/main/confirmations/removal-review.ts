import type { DialogContent, RemovalItem, RemovalFeed } from "../../shared/confirmation";

interface Batch {
  items: RemovalItem[];
  listeners: Set<() => void>;
  selected: Set<string>;
  controller: AbortController;
  result: Promise<boolean>;
}

/** Preserve the ordinary confirmation until there is more than one item to review. */
export function removalContent(items: readonly RemovalItem[]): DialogContent {
  const item = items.length === 1 ? items[0] : undefined;
  if (!item)
    return { title: "Remove worktrees?", glyph: "branch", accept: "Approve all", removals: items };
  return {
    title: item.changes ? "Remove worktree with uncommitted changes?" : "Remove worktree?",
    subject: item.branch,
    glyph: "branch",
    accept: item.changes ? "Discard changes and remove" : "Remove worktree",
    facts: [
      { label: "Worktree", value: item.path, mono: true },
      { label: "State", value: item.changes ? "Dirty" : "Clean" },
      ...(item.pullRequest
        ? [
            {
              label: "PR",
              value: `#${String(item.pullRequest.number)} · ${item.pullRequest.state}`,
            },
          ]
        : []),
    ],
    ...(item.changes ? { changes: item.changes } : {}),
  };
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
    let decline: (value: boolean) => void = () => undefined;
    const cancelled = new Promise<boolean>((resolve) => {
      decline = resolve;
    });
    const cancel = () => {
      current.items = current.items.filter((entry) => entry.id !== item.id);
      decline(false);
      if (current.items.length === 0) {
        if (this.batches.get(group) === current) this.batches.delete(group);
        current.controller.abort();
      } else {
        for (const listener of current.listeners) listener();
      }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    current.items.push(item);
    for (const listener of current.listeners) listener();
    try {
      return (
        (await Promise.race([current.result, cancelled])) &&
        !current.controller.signal.aborted &&
        !signal?.aborted &&
        current.selected.has(item.id)
      );
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
}
