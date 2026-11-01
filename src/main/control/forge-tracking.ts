import { ControlError } from "../../shared/control-validation";
import { hostAlias, codeFolder, gitOrigin } from "../../shared/registered-hosts";
import { remotePath } from "../../shared/remote-agent-protocol";
import { locationId } from "./metadata";
import type { BoardPullRequest } from "../../shared/forge";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { atomicPrivate, privateDirectory, verifyPrivate } from "../../node-common/private-files";
import { forgeBranch, forgeWebUrl, pullRequest } from "./forge";
import type {
  ForgeInspection,
  ForgeMatch,
  ForgeProvider,
  ForgeProviderFactory,
  ForgeWorktree,
  PullRequest,
} from "./forge.d";

interface Entry extends ForgeWorktree {
  prBranch?: string;
  inspectedHead?: string;
  binding?: string;
  restored?: boolean;
  board?: BoardPullRequest;
  /** Fresh observation provenance; never restored from disk or sent to the renderer. */
  routedHost?: string;
  orchestrator: boolean;
  refresh: number;
  sampledRefresh: number;
  observation: number;
  readonly observationWaiters: Map<symbol, number>;
  followUp?: boolean;
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
  private observation = 0;
  private readonly pauses = new Set<string>();
  onCompleted?: (tree: ForgeWorktree, pr: BoardPullRequest) => void;
  private stopped(): boolean {
    return this.closed;
  }
  constructor(
    private readonly directory: string,
    private readonly inspectCheckout: (
      tree: ForgeWorktree,
      orchestrator?: boolean,
    ) => Promise<string | ForgeInspection | undefined>,
    private readonly changed: () => void,
    private readonly provider: ForgeProviderFactory = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  static async open(
    userData: string,
    inspect: (
      tree: ForgeWorktree,
      orchestrator?: boolean,
    ) => Promise<string | ForgeInspection | undefined>,
    changed: () => void,
    provider: ForgeProviderFactory = () => undefined,
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
      const envelope =
        typeof data === "object" && data !== null && !Array.isArray(data)
          ? Object.fromEntries(Object.entries(data))
          : undefined;
      const saved: unknown = Array.isArray(data)
        ? data
        : envelope?.["version"] === 1
          ? envelope["entries"]
          : undefined;
      if (!Array.isArray(saved) || saved.length > 1000) return;
      const rows: unknown[] = saved;
      for (const item of rows) {
        if (typeof item !== "object" || item === null) continue;
        const row: Record<string, unknown> = Object.fromEntries(Object.entries(item));
        const { repository, path, identity, branch, remote, number } = row;
        const tree = {
          repository,
          path,
          identity,
          branch,
          ...(row["remoteCheckout"] === undefined ? {} : { remoteCheckout: row["remoteCheckout"] }),
        };
        if (!validTree(tree)) continue;
        if (remote !== undefined && (typeof remote !== "string" || remote.length > 4096)) continue;
        if (
          number !== undefined &&
          (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)
        )
          continue;
        if (row["orchestrator"] !== undefined && typeof row["orchestrator"] !== "boolean") continue;
        const binding = row["binding"];
        if (binding !== undefined && (typeof binding !== "string" || binding.length > 8192))
          continue;
        const prBranch = row["prBranch"];
        if (prBranch !== undefined && !forgeBranch(prBranch)) continue;
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
          entry.restored = true;
          if (typeof prBranch === "string") entry.prBranch = prBranch;
          if (typeof binding === "string") entry.binding = binding;
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
      JSON.stringify(previous.remoteCheckout) === JSON.stringify(tree.remoteCheckout) &&
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
      sampledRefresh: -1,
      observation: 0,
      observationWaiters: new Map(),
      ...(number === undefined ? {} : { number }),
      available: false,
      failures: 0,
      due: 0,
    });
    this.schedule();
  }

  /** Explicit numeric binding never substitutes the PR branch for checkout identity. */
  async bindPullRequest(repository: string, path: string, number: number): Promise<void> {
    try {
      const entry = this.entries.get(path);
      if (!entry || entry.repository !== repository || !Number.isSafeInteger(number) || number <= 0)
        throw new ControlError("pr_binding_unresolved");
      const generation = this.generation;
      const remote = await this.inspect(entry, true).catch(() => undefined);
      if (!remote) throw new ControlError("pr_binding_unresolved");
      const head = entry.inspectedHead;
      const provider = await this.provider(remote, () => this.context([entry], remote, new Set()));
      const resolved = await provider?.resolve?.(number);
      if (!resolved) throw new ControlError("pr_binding_unresolved");
      if (resolved.state !== "OPEN") throw new ControlError("pr_not_open");
      if (!resolved.sameRepository) throw new ControlError("pr_from_fork");
      if (!forgeBranch(resolved.branch)) throw new ControlError("invalid_branch");
      const pr = pullRequest(await provider?.lookup(resolved.branch, number));
      if (!pr || pr.number !== number || pr.state !== "OPEN" || head !== pr.headSha)
        throw new ControlError("pr_binding_unresolved");
      if (
        this.closed ||
        this.generation !== generation ||
        this.entries.get(path) !== entry ||
        (await this.inspect(entry, true).catch(() => undefined)) !== remote ||
        entry.inspectedHead !== head
      )
        throw new ControlError("pr_binding_unresolved");
      // The inspection may yield to Settings invalidation or checkout replacement.
      // Recheck the captured tracker state before publishing any binding.
      if (this.stopped() || this.generation !== generation || this.entries.get(path) !== entry)
        throw new ControlError("pr_binding_unresolved");
      this.bind(entry, provider);
      // Retire in-flight samples captured before this explicit binding.
      const bound: Entry = {
        ...entry,
        prBranch: resolved.branch,
        number,
        pr,
        remote,
        available: true,
        refresh: entry.refresh + 1,
        due: 0,
      };
      delete bound.board;
      delete bound.routedHost;
      this.entries.set(path, bound);
      this.changed();
      await this.save();
    } catch (error) {
      if (error instanceof ControlError) throw error;
      throw new ControlError("pr_binding_unresolved");
    }
  }

  /** Selection changes retire observations and bindings, including pending publication. */
  invalidate(): void {
    this.generation++;
    for (const entry of this.entries.values()) {
      entry.available = false;
      delete entry.pr;
      delete entry.board;
      delete entry.number;
      delete entry.prBranch;
      delete entry.binding;
      delete entry.restored;
      delete entry.followUp;
      entry.due = 0;
    }
    this.changed();
  }

  private async inspect(tree: Entry, orchestrator?: boolean): Promise<string | undefined> {
    const result = await this.inspectCheckout(tree, orchestrator);
    if (typeof result === "string" || result === undefined) {
      delete tree.inspectedHead;
      return tree.remoteCheckout ? undefined : result;
    }
    tree.inspectedHead = result.head;
    return result.remote;
  }

  private remoteRetryDeferred(entry: Entry): boolean {
    return entry.remoteCheckout !== undefined && !entry.available && entry.due > this.now();
  }

  private async context(rows: readonly Entry[], remote: string, retired: Set<Entry>) {
    // A healthy checkout must not retry another host before its backoff expires.
    rows = rows.filter((row) => !this.remoteRetryDeferred(row));
    for (const row of rows) {
      if (
        row.remoteCheckout &&
        (await this.inspect(row, row.orchestrator).catch(() => undefined)) !== remote
      )
        retired.add(row);
    }
    const heads = new Map(rows.map((row) => [row, row.inspectedHead]));
    return {
      identity: JSON.stringify(
        rows.map(({ repository, path, identity, branch, remoteCheckout, inspectedHead }) => [
          repository,
          path,
          identity,
          branch,
          remote,
          remoteCheckout,
          remoteCheckout ? inspectedHead : undefined,
        ]),
      ),
      validate: async (branches?: readonly string[]) => {
        for (const row of rows) {
          // Batch preparation explicitly retires invalid checkouts before sampling.
          // Later removals or replacements still invalidate the captured context.
          if (retired.has(row)) continue;
          if (branches && !branches.includes(row.prBranch ?? row.branch)) continue;
          if (
            this.stopped() ||
            this.entries.get(row.path) !== row ||
            (await this.inspect(row, row.orchestrator)) !== remote ||
            // Remote heads are polling provenance. Local numeric binding pins
            // HEAD independently; ordinary local polls tolerate author commits.
            (row.remoteCheckout !== undefined && row.inspectedHead !== heads.get(row))
          )
            throw new Error("Forge worktree changed");
        }
      },
    };
  }

  private bind(entry: Entry, provider: ForgeProvider | undefined): void {
    if (provider?.binding === undefined) return;
    if (
      (entry.binding !== undefined && entry.binding !== provider.binding) ||
      (entry.restored && entry.binding === undefined && !provider.acceptLegacyBinding)
    ) {
      delete entry.number;
      delete entry.prBranch;
      delete entry.pr;
      delete entry.board;
      entry.available = false;
    }
    entry.binding = provider.binding;
    delete entry.restored;
  }

  get boardEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    for (const entry of this.entries.values()) {
      // An older read must not replace this requested refresh with its next cadence.
      entry.refresh++;
      entry.due = 0;
    }
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
      if (!entry.orchestrator && !entry.remoteCheckout) this.entries.delete(path);
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

  /** Recheck against the selected remote at the existing main-owned link boundary. */
  readUrl(repository: string, path: string): string | undefined {
    const entry = this.entries.get(path);
    const board = this.readBoard(repository, path);
    return entry?.routedHost ? forgeWebUrl(board?.url, entry.routedHost) : undefined;
  }

  read(repository: string, path: string): PullRequest | undefined {
    const entry = this.entries.get(path);
    return entry?.repository === repository && entry.available ? pullRequest(entry.pr) : undefined;
  }

  /** Main-only request clock. An exit records this before accepting later observations. */
  revision(): number {
    return this.observation;
  }

  /** Main-only close evidence: a later request, with every recheck completed first. */
  readSettled(repository: string, path: string, after = -1): PullRequest | undefined {
    const entry = this.entries.get(path);
    return entry && entry.observation > after && entry.sampledRefresh === entry.refresh
      ? this.read(repository, path)
      : undefined;
  }

  /** Register local interest only; never schedules a read. Cancellation is idempotent. */
  waitForRead(repository: string, path: string, after: number): () => void {
    const entry = this.entries.get(path);
    if (!entry || entry.repository !== repository || this.readSettled(repository, path, after))
      return () => {};
    const token = Symbol();
    entry.observationWaiters.set(token, after);
    return () => {
      entry.observationWaiters.delete(token);
    };
  }

  private settleWaiters(entry: Entry): boolean {
    let settled = false;
    for (const [token, after] of entry.observationWaiters) {
      if (!this.readSettled(entry.repository, entry.path, after)) continue;
      entry.observationWaiters.delete(token);
      settled = true;
    }
    return settled;
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
        const refresh = entry.refresh;
        const remote = await this.inspect(entry, entry.orchestrator).catch(() => undefined);
        if (this.stopped() || this.pauses.size > 0 || this.entries.get(entry.path) !== entry)
          return;
        const previous = entry.available ? JSON.stringify(entry.pr) : undefined;
        let refreshed = false;
        if (remote === undefined) {
          if (entry.remoteCheckout) {
            entry.available = false;
            entry.failures = Math.min(entry.failures + 1, 5);
            entry.due = this.now() + forgeDelay(entry.failures);
          } else this.entries.delete(entry.path);
        } else {
          if (entry.remote !== undefined && remote !== entry.remote) {
            delete entry.number;
            delete entry.prBranch;
          }
          const candidates = [...this.entries.values()].filter(
            (row) => row.repository === entry.repository && (row.orchestrator || this.enabled),
          );
          const retired = new Set<Entry>();
          const provider = await this.provider(remote, () =>
            Promise.resolve(this.context(candidates, remote, retired)),
          );
          if (generation !== this.generation) return;
          if (provider?.batch) {
            await this.pollRepository(entry.repository, remote, provider, retired);
            return;
          }
          this.bind(entry, provider);
          const observation = ++this.observation;
          const head = entry.inspectedHead;
          const result = await provider
            ?.lookup(
              entry.prBranch ?? entry.branch,
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
          const valid =
            !entry.remoteCheckout ||
            ((await this.inspect(entry, entry.orchestrator).catch(() => undefined)) === remote &&
              entry.inspectedHead === head);
          if (
            this.stopped() ||
            generation !== this.generation ||
            this.entries.get(entry.path) !== entry
          )
            return;
          const pr = valid ? pullRequest(result) : undefined;
          entry.available = pr !== undefined;
          if (pr) {
            entry.pr = pr;
            entry.observation = observation;
            entry.remote = remote;
            entry.failures = 0;
          } else entry.failures = Math.min(entry.failures + 1, 5);
          entry.due =
            refresh === entry.refresh
              ? this.now() + Math.max(forgeDelay(entry.failures), provider?.minimumIntervalMs ?? 0)
              : 0;
          refreshed = entry.sampledRefresh !== refresh && refresh === entry.refresh;
          entry.sampledRefresh = refresh;
        }
        const current = this.read(entry.repository, entry.path);
        const settled = this.settleWaiters(entry);
        if (
          settled ||
          refreshed ||
          previous !== (current === undefined ? undefined : JSON.stringify(current))
        )
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
    retired: Set<Entry>,
  ): Promise<void> {
    const generation = this.generation;
    const candidates = [...this.entries.values()].filter(
      (entry) =>
        entry.repository === repository &&
        (entry.orchestrator || this.enabled) &&
        !this.remoteRetryDeferred(entry),
    );
    const rows: Entry[] = [];
    for (const entry of candidates) {
      const current = await this.inspect(entry, entry.orchestrator).catch(() => undefined);
      if (this.stopped() || this.pauses.size > 0) return;
      if (this.entries.get(entry.path) !== entry) continue;
      if (current !== remote) {
        retired.add(entry);
        if (entry.remoteCheckout) {
          entry.available = false;
          entry.due = this.now() + forgeDelay(++entry.failures);
        } else this.entries.delete(entry.path);
        this.changed();
        continue;
      }
      if (entry.remote !== undefined && entry.remote !== remote) {
        delete entry.number;
        delete entry.prBranch;
        delete entry.pr;
        delete entry.board;
        entry.available = false;
      }
      this.bind(entry, provider);
      rows.push(entry);
    }
    if (rows.length === 0) return;
    const match = (entry: Entry) => {
      const number =
        entry.remote === undefined || entry.remote === remote
          ? (entry.number ?? entry.pr?.number)
          : undefined;
      return {
        branch: entry.prBranch ?? entry.branch,
        ...(number === undefined ? {} : { number }),
      };
    };
    // Start with the oldest due checkout. An unsampled suffix stays due for the next
    // serial worker tick, rather than being hidden or retried inside one sample.
    rows.sort(
      (a, b) =>
        Number(b.followUp === true && b.due <= this.now()) -
          Number(a.followUp === true && a.due <= this.now()) || a.due - b.due,
    );
    // Author and detached review checkouts can have different cached PR hints for
    // one branch. Resolve conflicting hints by branch instead of sending duplicate
    // branches, which the provider deliberately rejects.
    const byBranch = new Map<string, ForgeMatch>();
    for (const entry of rows) {
      const request = match(entry);
      const previous = byBranch.get(request.branch);
      byBranch.set(
        request.branch,
        previous && previous.number !== request.number ? { branch: request.branch } : request,
      );
    }
    const requests = [...byBranch.values()];
    const size = provider.batchSize?.(requests) ?? requests.length;
    const matches = requests.slice(0, Math.max(1, size));
    const keys = new Set(matches.map((request) => request.branch));
    const selected = rows.filter((entry) => keys.has(entry.prBranch ?? entry.branch));
    const revisions = new Map(rows.map((entry) => [entry, entry.refresh]));
    const heads = new Map(rows.map((entry) => [entry, entry.inspectedHead]));
    const observation = ++this.observation;
    const result = await provider.batch?.(matches).catch(() => undefined);
    if (this.stopped() || generation !== this.generation || this.pauses.size > 0) return;
    const remaining = rows.filter((entry) => !selected.includes(entry) && entry.available);
    const running =
      result &&
      ([...result.values()].some(
        (pr) =>
          pr.state === "OPEN" &&
          (pr.board.checks === null ||
            pr.board.checks.pending > 0 ||
            pr.requiredChecks === "unknown"),
      ) ||
        remaining.some(
          (entry) =>
            entry.pr?.state === "OPEN" &&
            (!entry.board?.checks ||
              entry.board.checks.pending > 0 ||
              entry.pr.requiredChecks === "unknown"),
        ));
    const hasMatches = result && (result.size > 0 || remaining.some((entry) => entry.pr));
    // A failed chunk is a failed repository read. Preserve the shared backoff and
    // hide every stale observation instead of letting a due suffix retry next tick.
    const failures = result ? 0 : Math.min(Math.max(...rows.map((entry) => entry.failures)) + 1, 5);
    for (const entry of rows) entry.failures = failures;
    for (const entry of result ? selected : rows) {
      if (this.entries.get(entry.path) !== entry || (!this.enabled && !entry.orchestrator))
        continue;
      const previous = entry.available ? JSON.stringify([entry.pr, entry.board]) : undefined;
      const valid =
        !entry.remoteCheckout ||
        ((await this.inspect(entry, entry.orchestrator).catch(() => undefined)) === remote &&
          entry.inspectedHead === heads.get(entry));
      if (
        this.stopped() ||
        generation !== this.generation ||
        this.entries.get(entry.path) !== entry
      )
        continue;
      const pr = valid ? result?.get(entry.prBranch ?? entry.branch) : undefined;
      const old = entry.board;
      const oldHead = entry.pr?.headSha;
      const discovered = pr && !entry.pr && entry.number === undefined;
      entry.available = pr !== undefined;
      entry.followUp = Boolean(discovered);
      if (pr) {
        const { board, ...metadata } = pr;
        entry.pr = metadata;
        entry.observation = observation;
        entry.board = board;
        if (provider.routedHost === undefined) delete entry.routedHost;
        else entry.routedHost = provider.routedHost;
      }
      entry.remote = remote;
      entry.due =
        this.now() +
        (discovered
          ? 1000
          : Math.max(
              provider.minimumIntervalMs ?? 0,
              !result ? forgeDelay(entry.failures) : running ? 20000 : hasMatches ? 120000 : 600000,
            ));
      const refresh = revisions.get(entry) ?? -1;
      const refreshed = entry.sampledRefresh !== refresh && refresh === entry.refresh;
      entry.sampledRefresh = refresh;
      if (entry.refresh !== refresh) entry.due = 0;
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
      const settled = this.settleWaiters(entry);
      if (settled || refreshed || previous !== current) this.changed();
    }
    await this.save();
  }

  private async save(): Promise<void> {
    await atomicPrivate(this.directory, "forge.json", {
      version: 1,
      entries: [...this.entries.values()].map((entry) => ({
        remoteCheckout: entry.remoteCheckout,
        binding: entry.binding,
        repository: entry.repository,
        path: entry.path,
        identity: entry.identity,
        branch: entry.branch,
        prBranch: entry.prBranch,
        remote: entry.remote,
        pr: entry.pr,
        number: entry.number,
        orchestrator: entry.orchestrator,
      })),
    });
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
  remoteCheckout?: unknown;
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
    forgeBranch(tree.branch) &&
    validRemoteCheckout(tree.remoteCheckout, tree.path)
  );
}

function validRemoteCheckout(value: unknown, path: string): boolean {
  if (value === undefined) return !path.startsWith("/foom-remote/");
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  return (
    Object.keys(row).length === 5 &&
    hostAlias(row["host"]) &&
    codeFolder(row["codeFolder"]) &&
    remotePath(row["codeFolder"]) &&
    remotePath(row["repository"]) &&
    remotePath(row["path"]) &&
    gitOrigin(row["origin"]) &&
    row["path"].startsWith(`${row["codeFolder"]}/.foom-worktree-`) &&
    !row["path"].slice(row["codeFolder"].length + 1).includes("/") &&
    path === `/foom-remote/${locationId(JSON.stringify([row["host"], row["path"]]))}`
  );
}
