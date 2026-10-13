import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { atomicPrivate, privateDirectory, verifyPrivate } from "./private-files";
import { forgeBranch, forgeProvider, pullRequest } from "./forge";
import type { ForgeProvider, ForgeWorktree, PullRequest } from "./forge.d";

interface Entry extends ForgeWorktree {
  remote?: string;
  pr?: PullRequest;
  available: boolean;
  failures: number;
  due: number;
}

export function forgeDelay(failures: number): number {
  return Math.min(600000, 30000 * 2 ** Math.min(failures, 5));
}

/** Durable observations confer no terminal, worktree or orchestration authority. */
export class ForgeTracking {
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> = Promise.resolve();
  private closed = false;
  private stopped(): boolean {
    return this.closed;
  }
  constructor(
    private readonly directory: string,
    private readonly inspect: (tree: ForgeWorktree) => Promise<string | undefined>,
    private readonly changed: () => void,
    private readonly provider: (remote: string) => ForgeProvider | undefined = forgeProvider,
    private readonly now: () => number = Date.now,
  ) {}

  static async open(
    userData: string,
    inspect: (tree: ForgeWorktree) => Promise<string | undefined>,
    changed: () => void,
  ): Promise<ForgeTracking> {
    const tracker = new ForgeTracking(await privateDirectory(userData), inspect, changed);
    await tracker.load();
    tracker.schedule();
    return tracker;
  }

  async load(): Promise<void> {
    try {
      const file = join(this.directory, "forge.json");
      await verifyPrivate(file, false);
      if ((await lstat(file)).size > 16 * 1024 * 1024) return;
      const data: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!Array.isArray(data) || data.length > 1000) return;
      const rows: unknown[] = data;
      for (const item of rows) {
        if (typeof item !== "object" || item === null) continue;
        const row: Record<string, unknown> = Object.fromEntries(Object.entries(item));
        const { repository, path, identity, branch, remote } = row;
        const tree = { repository, path, identity, branch };
        if (!validTree(tree)) continue;
        if (remote !== undefined && (typeof remote !== "string" || remote.length > 4096)) continue;
        const pr = pullRequest(row["pr"]);
        if (row["pr"] !== undefined && !pr) continue;
        // Revalidate ownership before making any network call or exposing saved data.
        this.track(tree);
        const entry = this.entries.get(tree.path);
        if (entry) {
          if (pr) entry.pr = pr;
          if (typeof remote === "string") entry.remote = remote;
        }
      }
    } catch {
      // Missing/corrupt observations do not affect app startup or grant ownership.
    }
  }

  track(tree: ForgeWorktree): void {
    if (this.closed || !validTree(tree)) return;
    const previous = this.entries.get(tree.path);
    if (
      previous?.identity === tree.identity &&
      previous.branch === tree.branch &&
      previous.repository === tree.repository
    )
      return;
    if (this.entries.size >= 1000 && !previous) return;
    this.entries.set(tree.path, { ...tree, available: false, failures: 0, due: 0 });
    this.schedule();
  }

  read(repository: string, path: string): PullRequest | undefined {
    const entry = this.entries.get(path);
    return entry?.repository === repository && entry.available ? pullRequest(entry.pr) : undefined;
  }

  /** Serial, globally spaced requests; one worktree per tick, no overlap or catch-up burst. */
  poll(): Promise<void> {
    this.running = this.running
      .then(async () => {
        if (this.closed) return;
        const entry = [...this.entries.values()]
          .sort((a, b) => a.due - b.due)
          .find((row) => row.due <= this.now());
        if (!entry) return;
        const remote = await this.inspect(entry).catch(() => undefined);
        if (this.stopped() || this.entries.get(entry.path) !== entry) return;
        const previous = entry.available ? JSON.stringify(entry.pr) : undefined;
        if (remote === undefined) {
          this.entries.delete(entry.path);
        } else {
          const provider = this.provider(remote);
          const result = await provider
            ?.lookup(entry.branch, remote === entry.remote ? entry.pr?.number : undefined, "all")
            .catch(() => undefined);
          if (this.stopped() || this.entries.get(entry.path) !== entry) return;
          const pr = pullRequest(result);
          entry.available = pr !== undefined;
          if (pr) {
            entry.pr = pr;
            entry.remote = remote;
            entry.failures = 0;
          } else entry.failures = Math.min(entry.failures + 1, 5);
          entry.due = this.now() + forgeDelay(entry.failures);
        }
        const current = this.read(entry.repository, entry.path);
        if (previous !== (current === undefined ? undefined : JSON.stringify(current)))
          this.changed();
        await this.save();
      })
      .catch(() => undefined);
    return this.running;
  }

  private async save(): Promise<void> {
    await atomicPrivate(
      this.directory,
      "forge.json",
      [...this.entries.values()].map((entry) => ({
        repository: entry.repository,
        path: entry.path,
        identity: entry.identity,
        branch: entry.branch,
        remote: entry.remote,
        pr: entry.pr,
      })),
    );
  }

  private schedule(): void {
    if (this.closed || this.timer || this.entries.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll().finally(() => {
        this.schedule();
      });
    }, 1000);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await this.running;
    await this.save().catch(() => undefined);
  }
}

function validTree(tree: {
  repository: unknown;
  path: unknown;
  identity: unknown;
  branch: unknown;
}): tree is ForgeWorktree {
  return (
    typeof tree.repository === "string" &&
    typeof tree.path === "string" &&
    [tree.repository, tree.path].every(
      (path) => isAbsolute(path) && path.length <= 4096 && !/[\p{Cc}\p{Cf}]/u.test(path),
    ) &&
    typeof tree.identity === "string" &&
    tree.identity.length > 0 &&
    tree.identity.length <= 4096 &&
    forgeBranch(tree.branch)
  );
}
