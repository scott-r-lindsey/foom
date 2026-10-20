import type { BoardPullRequest } from "../../shared/forge";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { atomicPrivate, privateDirectory, verifyPrivate } from "../../node-common/private-files";
import { forgeBranch, legacyForgeProvider, pullRequest } from "./forge";
import type { ForgeProvider, ForgeProviderFactory, ForgeWorktree, PullRequest } from "./forge.d";

interface Entry extends ForgeWorktree {
  board?: BoardPullRequest;
  orchestrator: boolean;
  refresh: number;
  remote?: string;
  number?: number;
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
  private enabled = false;
  private generation = 0;
  private readonly pauses = new Set<string>();
  onCompleted?: (tree: ForgeWorktree, pr: BoardPullRequest) => void;
  private stopped(): boolean {
    return this.closed;
  }
  constructor(
    private readonly directory: string,
    private readonly inspect: (
      tree: ForgeWorktree,
      orchestrator?: boolean,
    ) => Promise<string | undefined>,
    private readonly changed: () => void,
    private readonly provider: ForgeProviderFactory = legacyForgeProvider,
    private readonly now: () => number = Date.now,
  ) {}

  static async open(
    userData: string,
    inspect: (tree: ForgeWorktree, orchestrator?: boolean) => Promise<string | undefined>,
    changed: () => void,
    provider: ForgeProviderFactory = legacyForgeProvider,
  ): Promise<ForgeTracking> {
    const tracker = new ForgeTracking(await privateDirectory(userData), inspect, changed, provider);
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
        const { repository, path, identity, branch, remote, number } = row;
        const tree = { repository, path, identity, branch };
        if (!validTree(tree)) continue;
        if (remote !== undefined && (typeof remote !== "string" || remote.length > 4096)) continue;
        if (
          number !== undefined &&
          (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)
        )
          continue;
        if (row["orchestrator"] !== undefined && typeof row["orchestrator"] !== "boolean") continue;
        const pr = pullRequest(row["pr"]);
        if (row["pr"] !== undefined && !pr) continue;
        // Revalidate ownership before making any network call or exposing saved data.
        this.track(
          tree,
          typeof number === "number" ? number : undefined,
          row["orchestrator"] !== false,
        );
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

  track(tree: ForgeWorktree, number?: number, orchestrator = true): void {
    if (
      this.closed ||
      !validTree(tree) ||
      (number !== undefined && (!Number.isSafeInteger(number) || number <= 0))
    )
      return;
    const previous = this.entries.get(tree.path);
    if (
      previous?.identity === tree.identity &&
      previous.branch === tree.branch &&
      previous.repository === tree.repository &&
      (number === undefined || previous.number === number)
    ) {
      if (orchestrator) previous.orchestrator = true;
      return;
    }
    if (this.entries.size >= 1000 && !previous) return;
    this.entries.set(tree.path, {
      ...tree,
      orchestrator,
      refresh: 0,
      ...(number === undefined ? {} : { number }),
      available: false,
      failures: 0,
      due: 0,
    });
    this.schedule();
  }

  /** Selection changes retire observations and bindings, including pending publication. */
  invalidate(): void {
    this.generation++;
    for (const entry of this.entries.values()) {
      entry.available = false;
      delete entry.pr;
      delete entry.board;
      delete entry.number;
      entry.due = 0;
    }
    this.changed();
  }

  private context(rows: readonly Entry[], remote: string) {
    return {
      identity: JSON.stringify(
        rows.map(({ repository, path, identity, branch }) => [
          repository,
          path,
          identity,
          branch,
          remote,
        ]),
      ),
      validate: async () => {
        for (const row of rows) {
          if (
            this.stopped() ||
            this.entries.get(row.path) !== row ||
            (await this.inspect(row, row.orchestrator)) !== remote
          )
            throw new Error("Forge worktree changed");
        }
      },
    };
  }

  get boardEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    for (const entry of this.entries.values()) entry.due = 0;
    this.changed();
    this.schedule();
  }

  pause(reason: string, paused: boolean): void {
    if (paused) this.pauses.add(reason);
    else this.pauses.delete(reason);
    this.schedule();
  }

  sync(repository: string, trees: readonly ForgeWorktree[]): void {
    const paths = new Set(trees.map((tree) => tree.path));
    for (const [path, entry] of this.entries) {
      if (entry.repository !== repository || paths.has(path)) continue;
      if (!entry.orchestrator) this.entries.delete(path);
    }
    for (const tree of trees) this.track(tree, undefined, false);
  }

  recheck(path: string): void {
    const entry = this.entries.get(path);
    if (!entry || (!this.enabled && !entry.orchestrator)) return;
    entry.refresh++;
    entry.due = 0;
    void this.poll();
  }

  readBoard(repository: string, path: string): BoardPullRequest | undefined {
    const entry = this.entries.get(path);
    return this.enabled && entry?.repository === repository && entry.available
      ? entry.board
      : undefined;
  }

  read(repository: string, path: string): PullRequest | undefined {
    const entry = this.entries.get(path);
    return entry?.repository === repository && entry.available ? pullRequest(entry.pr) : undefined;
  }

  /** Serial repository batches (legacy providers retain single-checkout lookup). */
  poll(): Promise<void> {
    this.running = this.running
      .then(async () => {
        if (this.closed || this.pauses.size > 0) return;
        const entry = [...this.entries.values()]
          .sort((a, b) => a.due - b.due)
          .find((row) => row.due <= this.now() && (row.orchestrator || this.enabled));
        if (!entry) return;
        const generation = this.generation;
        const remote = await this.inspect(entry, entry.orchestrator).catch(() => undefined);
        if (this.stopped() || this.pauses.size > 0 || this.entries.get(entry.path) !== entry)
          return;
        const previous = entry.available ? JSON.stringify(entry.pr) : undefined;
        if (remote === undefined) {
          this.entries.delete(entry.path);
        } else {
          if (entry.remote !== undefined && remote !== entry.remote) delete entry.number;
          const candidates = [...this.entries.values()].filter(
            (row) => row.repository === entry.repository && (row.orchestrator || this.enabled),
          );
          const provider = await this.provider(remote, () =>
            Promise.resolve(this.context(candidates, remote)),
          );
          if (generation !== this.generation) return;
          if (provider?.batch) {
            await this.pollRepository(entry.repository, remote, provider);
            return;
          }
          const result = await provider
            ?.lookup(
              entry.branch,
              entry.number ?? (remote === entry.remote ? entry.pr?.number : undefined),
            )
            .catch(() => undefined);
          if (
            this.stopped() ||
            generation !== this.generation ||
            this.pauses.size > 0 ||
            this.entries.get(entry.path) !== entry
          )
            return;
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

  private async pollRepository(
    repository: string,
    remote: string,
    provider: ForgeProvider,
  ): Promise<void> {
    const generation = this.generation;
    const candidates = [...this.entries.values()].filter(
      (entry) => entry.repository === repository && (entry.orchestrator || this.enabled),
    );
    const rows: Entry[] = [];
    for (const entry of candidates) {
      const current = await this.inspect(entry, entry.orchestrator).catch(() => undefined);
      if (this.stopped() || this.pauses.size > 0) return;
      if (this.entries.get(entry.path) !== entry) continue;
      if (current !== remote) {
        this.entries.delete(entry.path);
        this.changed();
        continue;
      }
      if (entry.remote !== undefined && entry.remote !== remote) {
        delete entry.number;
        delete entry.pr;
        delete entry.board;
        entry.available = false;
      }
      rows.push(entry);
    }
    if (rows.length === 0) return;
    const revisions = new Map(rows.map((entry) => [entry, entry.refresh]));
    const result = await provider
      .batch?.(
        rows.map((entry) => {
          const number =
            entry.remote === undefined || entry.remote === remote
              ? (entry.number ?? entry.pr?.number)
              : undefined;
          return { branch: entry.branch, ...(number === undefined ? {} : { number }) };
        }),
      )
      .catch(() => undefined);
    if (this.stopped() || generation !== this.generation || this.pauses.size > 0) return;
    const running =
      result &&
      [...result.values()].some(
        (pr) =>
          pr.state === "OPEN" &&
          (pr.board.checks === null ||
            pr.board.checks.pending > 0 ||
            pr.requiredChecks === "unknown"),
      );
    for (const entry of rows) {
      if (this.entries.get(entry.path) !== entry || (!this.enabled && !entry.orchestrator))
        continue;
      const previous = entry.available ? JSON.stringify([entry.pr, entry.board]) : undefined;
      const pr = result?.get(entry.branch);
      const old = entry.board;
      const oldHead = entry.pr?.headSha;
      const discovered = pr && !entry.pr && entry.number === undefined;
      entry.available = pr !== undefined;
      if (pr) {
        entry.pr = {
          number: pr.number,
          headSha: pr.headSha,
          state: pr.state,
          requiredChecks: pr.requiredChecks,
        };
        entry.board = pr.board;
      }
      entry.remote = remote;
      entry.failures = result ? 0 : Math.min(entry.failures + 1, 5);
      entry.due =
        this.now() +
        (discovered
          ? 1000
          : !result
            ? forgeDelay(entry.failures)
            : running
              ? 20000
              : result.size
                ? 120000
                : 600000);
      if (entry.refresh !== revisions.get(entry)) entry.due = 0;
      if (
        pr &&
        old &&
        pr.board.state === "OPEN" &&
        pr.board.checks &&
        pr.board.checks.pending === 0 &&
        (oldHead !== pr.headSha ||
          old.number !== pr.number ||
          old.checks?.pending !== 0 ||
          old.checks.failed !== pr.board.checks.failed) &&
        pr.board.checks.passed + pr.board.checks.failed > 0
      )
        this.onCompleted?.(entry, pr.board);
      const current = entry.available ? JSON.stringify([entry.pr, entry.board]) : undefined;
      if (previous !== current) this.changed();
    }
    await this.save();
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
        number: entry.number,
        orchestrator: entry.orchestrator,
      })),
    );
  }

  private schedule(): void {
    if (this.closed || this.pauses.size > 0 || this.timer || this.entries.size === 0) return;
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
