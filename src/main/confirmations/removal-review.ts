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
    worktreePath: item.path,
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

/** All boards share one removal presentation slot, including live cleanup reviews. */
export class RemovalPresentations {
  private queue: Promise<void> = Promise.resolve();

  run(present: () => Promise<boolean>): Promise<boolean> {
    const result = this.queue.then(present);
    // One failed presentation must not strand later reviews on any board.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
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

/** Resolve only paths actually included in this pending removal presentation. */
export function removalCopyPaths(request: DialogContent): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  const changes = (value: string | undefined, prefix: string) => {
    const records = value?.split("\0").filter(Boolean) ?? [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record) continue;
      paths.set(`${prefix}:${String(index)}`, record.slice(3));
      if (/[RC]/u.test(record.slice(0, 2))) {
        const old = records[++index];
        if (old) paths.set(`${prefix}:${String(index)}`, old);
      }
    }
  };
  if (request.worktreePath) paths.set("worktree", request.worktreePath);
  changes(request.changes, "change");
  for (const item of request.removals ?? []) {
    paths.set(`removal:${item.id}`, item.path);
    changes(item.changes, `removal-change:${item.id}`);
  }
  for (const item of request.cleanup?.progress.items ?? [])
    changes(item.changes, `cleanup-change:${item.id}`);
  return paths;
}
