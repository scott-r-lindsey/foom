import { basename } from "node:path";
import { conversationId } from "../agents/conversation";
import { CleanupRun, KeptWorktree } from "./cleanup-run";
import type { CleanupCandidate } from "./cleanup-run";
import type { CleanupReason } from "../../shared/cleanup";
import type { ConfirmWorkspace } from "../../shared/confirmation";
import type { Worktree } from "../../shared/worktrees";
import type { WorkspaceTerminal } from "../../shared/workspace";
import type { WorktreeService } from "./worktrees";

export interface CleanupOwnerDependencies {
  worktrees: Pick<
    WorktreeService,
    | "changes"
    | "removalIdentity"
    | "launchIdentity"
    | "removeWorktree"
    | "removeRepository"
    | "mergedDefault"
    | "mergedFetchTime"
    | "mergedCommit"
    | "deleteMergedBranches"
    | "canAutoRemove"
  >;
  inventory: (repository: string) => Promise<readonly Worktree[]>;
  known: (repository: string) => void;
  withRepository: <T>(repository: string, work: () => Promise<T>) => Promise<T>;
  /** Validate before reserving, with the release kept synchronous after the last await. */
  reserveRepositoryRemoval: (repository: string, validate: () => void) => () => void;
  withWorktreeRemoval: (
    repository: string,
    worktree: string,
    branch: string | null,
    confirm: (branch: string, changes: string, automatic?: boolean) => Promise<boolean>,
    revalidate?: () => void | Promise<void>,
    retainBranchLock?: boolean,
    autoApprove?: () => Promise<boolean>,
  ) => Promise<boolean>;
  releaseWorktree: (repository: string, branch: string | null) => void;
  terminals: () => readonly WorkspaceTerminal[];
  running: (id: string) => boolean;
  exitCode: (id: string) => number | undefined;
  stop: (id: string) => Promise<void>;
  exited: (id: string, code: number) => Promise<void>;
  kill: (id: string) => Promise<void>;
  removed: (id: string) => void;
  prepareWorktreeRemoval?: (worktree: string) => Promise<() => void>;
  closed: () => boolean;
  refresh: () => void;
  onChange?: () => void;
  now: () => number;
}

/** Main-owned cleanup plans, scans, runs and safe removal coordination. */
export class CleanupOwner {
  private autoRemoveMergedWorktrees = false;
  private readonly cleanupRuns = new Map<string, CleanupRun>();
  private readonly mergeScans = new Map<string, Set<Promise<void>>>();
  private readonly mergeEligibility = new Map<
    string,
    {
      key: string;
      count: number;
      expires: number;
      plan?: readonly CleanupCandidate[];
      result: { canDeleteMerged: boolean; mergedCount?: number; mergedError?: string };
    }
  >();

  constructor(private readonly deps: CleanupOwnerDependencies) {}

  configure(autoRemoveMergedWorktrees: boolean): void {
    this.autoRemoveMergedWorktrees = autoRemoveMergedWorktrees;
  }

  async removeRepository(repository: string, confirm?: () => Promise<boolean>): Promise<void> {
    const checkSessions = () => {
      if (this.deps.terminals().some((entry) => entry.repository === repository))
        throw new Error("Close this repository's sessions first");
    };
    const release = this.deps.reserveRepositoryRemoval(repository, checkSessions);
    try {
      if (confirm && !(await confirm())) return;
      checkSessions();
      await this.deps.worktrees.removeRepository(repository);
      this.cleanupRuns.delete(repository);
      this.mergeEligibility.delete(repository);
      this.deps.refresh();
    } finally {
      release();
    }
  }

  async removeOwnedTree(
    repository: string,
    worktree: string,
    identity: string,
    confirm: (branch: string, changes: string, automatic?: boolean) => Promise<boolean>,
    revalidate: () => void,
  ): Promise<boolean> {
    const tree = (await this.deps.inventory(repository)).find((item) => item.path === worktree);
    if (!tree || tree.path === repository) throw new Error("Worktree is unavailable");
    // removeTree holds the branch lock while it calls this, so no launch can slip in.
    const available = async () => {
      this.requireIdleWorktree(worktree);
      if ((await this.deps.worktrees.launchIdentity(repository, worktree)) !== identity)
        throw new Error("Worktree has changed");
      revalidate();
    };
    const removed = await this.deps.withWorktreeRemoval(
      repository,
      worktree,
      tree.branch,
      async (branch, changes, automatic = false) => {
        await available();
        const accepted = await confirm(branch, changes, automatic);
        if (accepted) await available();
        return accepted;
      },
      available,
      false,
      async () => {
        await available();
        if (!this.autoRemoveMergedWorktrees) return false;
        const eligible = await this.deps.worktrees.canAutoRemove(repository, worktree, identity);
        await available();
        return eligible && this.autoRemoveMergedWorktrees;
      },
    );
    this.deps.refresh();
    return removed;
  }

  inventory(repository: string, worktrees: readonly Worktree[]) {
    const run = this.cleanupRuns.get(repository);
    return {
      removedWorktrees:
        run?.removedTrees.filter(
          (tree) => !worktrees.some((current) => current.path === tree.path),
        ) ?? [],
      ...this.cachedMergeEligibility(repository, worktrees),
      ...(run?.current().stage === "run" ? { cleanup: run.progress } : {}),
    };
  }

  async dispose(): Promise<void> {
    for (const run of this.cleanupRuns.values()) run.stop();
    await Promise.all([...this.cleanupRuns.values()].map((run) => run.settled()));
    this.cleanupRuns.clear();
    this.mergeEligibility.clear();
  }
  private requireIdleWorktree(worktree: string): void {
    if (
      this.deps
        .terminals()
        .some((entry) => entry.worktree === worktree && this.deps.running(entry.id))
    )
      throw new Error("A session is running in this worktree");
  }

  async removeIdleTree(
    repository: string,
    worktree: string,
    branch: string | null,
    confirm: (branch: string, changes: string) => Promise<boolean>,
  ): Promise<boolean> {
    this.requireIdleWorktree(worktree);
    return this.deps.withWorktreeRemoval(
      repository,
      worktree,
      branch,
      (name, changes) => {
        this.requireIdleWorktree(worktree);
        return confirm(name, changes);
      },
      () => {
        this.requireIdleWorktree(worktree);
      },
    );
  }

  /** Called with the shared branch reservation held by Workspace. */
  async removeReservedTree(
    repository: string,
    worktree: string,
    branch: string | null,
    confirm: (branch: string, changes: string, automatic?: boolean) => Promise<boolean>,
    revalidate?: () => void | Promise<void>,
    autoApprove?: () => Promise<boolean>,
  ): Promise<boolean> {
    const entry = { repository, worktree, branch };
    const identity = await this.deps.worktrees.removalIdentity(entry.repository, entry.worktree);
    let changes = await this.deps.worktrees.changes(entry.repository, entry.worktree, identity);
    const automatic = changes === "" && (await autoApprove?.()) === true;
    const accepted = automatic
      ? await confirm(entry.branch ?? entry.worktree, changes, true)
      : await confirm(entry.branch ?? entry.worktree, changes);
    if (!accepted) return false;
    await revalidate?.();
    if (
      !automatic &&
      (await this.deps.worktrees.changes(entry.repository, entry.worktree, identity)) !== changes
    )
      throw new Error("Worktree changes have changed. Review them and try again.");
    const entries = this.deps.terminals().filter((item) => item.worktree === entry.worktree);
    for (const item of entries) {
      if (item.dormant) continue;
      await this.deps.stop(item.id);
      await this.deps.exited(item.id, -1);
    }
    await revalidate?.();
    if (
      !automatic &&
      (await this.deps.worktrees.changes(entry.repository, entry.worktree, identity)) !== changes
    )
      throw new Error("Worktree changes have changed. Review them and try again.");
    // Automatic approval awaits another policy check below. Ordinary confirmation
    // has no intervening work before the final revalidation, so do it only once.
    if (automatic) await revalidate?.();
    if (automatic && !(await autoApprove?.())) {
      changes = await this.deps.worktrees.changes(entry.repository, entry.worktree, identity);
      if (!(await confirm(entry.branch ?? entry.worktree, changes))) return false;
      await revalidate?.();
      if (
        (await this.deps.worktrees.changes(entry.repository, entry.worktree, identity)) !== changes
      )
        throw new Error("Worktree changes have changed. Review them and try again.");
    }
    await revalidate?.();
    const release = await this.deps.prepareWorktreeRemoval?.(entry.worktree);
    try {
      await this.deps.worktrees.removeWorktree(
        entry.repository,
        entry.worktree,
        changes.length > 0,
        identity,
      );
    } finally {
      release?.();
    }
    for (const item of entries) {
      if (!item.dormant) await this.deps.kill(item.id);
      this.deps.removed(item.id);
    }
    return true;
  }

  private sessionSkip(worktree: string): CleanupReason | undefined {
    const sessions = this.deps.terminals().filter((item) => item.worktree === worktree);
    if (sessions.some((item) => this.deps.exitCode(item.id) === undefined)) return "running";
    if (sessions.some((item) => item.kind === "agent" && conversationId(item.conversationId)))
      return "resumable conversation";
    return undefined;
  }

  private async mergedPlan(repository: string, refresh: boolean, inventory?: readonly Worktree[]) {
    const trees = inventory ?? (await this.deps.inventory(repository));
    if (!trees.some((tree) => tree.path !== repository && !tree.bare)) return [];
    const base = await this.deps.worktrees.mergedDefault(repository, refresh);
    return Promise.all(
      trees.map(async (tree) => {
        let reason: CleanupReason | undefined;
        if (tree.path === repository || tree.bare) reason = "main checkout";
        else if (tree.locked || tree.prunable || !tree.branch) reason = "unavailable";
        else reason = this.sessionSkip(tree.path);
        if (!reason) {
          try {
            if (await this.deps.worktrees.changes(repository, tree.path))
              reason = "uncommitted changes";
            else if (!(await this.deps.worktrees.mergedCommit(repository, tree, base)))
              reason = "not merged";
          } catch {
            reason = "unavailable";
          }
        }
        if (reason) return { tree, reason };
        try {
          return {
            tree,
            reason,
            identity: await this.deps.worktrees.removalIdentity(repository, tree.path),
          };
        } catch {
          return { tree, reason: "unavailable" as const };
        }
      }),
    );
  }

  async deleteMerged(repository: string, confirm: ConfirmWorkspace): Promise<void> {
    this.deps.known(repository);
    const existing = this.cleanupRuns.get(repository);
    if (existing && (existing.pending || existing.current().stage === "run")) {
      await confirm({
        kind: "merged-worktrees",
        subject: basename(repository),
        worktrees: [],
        feed: existing,
      });
      if (!existing.pending) {
        this.cleanupRuns.delete(repository);
        this.deps.refresh();
      }
      return;
    }
    return this.deps.withRepository(repository, async () => {
      const run = new CleanupRun({
        checkingCount: this.mergeEligibility.get(repository)?.count,
        fetchedAt: () => this.deps.worktrees.mergedFetchTime(repository),
        fetch: async () => {
          // Windows cannot remove a checkout while a background Git process uses it as cwd.
          // Include superseded scans too: their publication is discarded, but they still run.
          await Promise.all([...(this.mergeScans.get(repository) ?? [])]);
          return this.deps.worktrees.mergedDefault(repository, true);
        },
        changed: () => {
          this.deps.refresh();
        },
        branches: async (removed) => {
          try {
            return await this.deps.worktrees.deleteMergedBranches(
              repository,
              removed.flatMap(({ tree }) =>
                tree.branch && tree.head ? [{ branch: tree.branch, head: tree.head }] : [],
              ),
            );
          } finally {
            for (const { tree } of removed) this.deps.releaseWorktree(repository, tree.branch);
          }
        },
        remove: async ({ tree, identity }, base) => {
          const revalidate = async () => {
            const current = (await this.deps.inventory(repository)).find(
              (item) => item.path === tree.path,
            );
            if (
              !current ||
              current.branch !== tree.branch ||
              current.head !== tree.head ||
              (await this.deps.worktrees.removalIdentity(repository, tree.path)) !== identity
            )
              throw new KeptWorktree("worktree changed");
            const reason = this.sessionSkip(tree.path);
            if (reason) throw new KeptWorktree(reason);
            if (await this.deps.worktrees.changes(repository, tree.path, identity))
              throw new KeptWorktree("uncommitted changes");
            // Re-read forge hints and local evidence; the displayed plan alone
            // never authorizes a later deletion.
            if (!(await this.deps.worktrees.mergedCommit(repository, current, base)))
              throw new KeptWorktree("not merged");
          };
          await this.deps.withWorktreeRemoval(
            repository,
            tree.path,
            tree.branch,
            // The run is already approved; removeTree revalidates immediately
            // after this callback and again around terminal shutdown and removal.
            () => Promise.resolve(true),
            revalidate,
            true,
          );
        },
      });
      this.cleanupRuns.set(repository, run);
      const cached = this.mergeEligibility.get(repository);
      const prepare =
        cached?.plan && this.deps.now() < cached.expires
          ? Promise.resolve(cached.plan)
          : this.mergedPlan(repository, true);
      if (cached?.plan && this.deps.now() < cached.expires) run.ready(cached.plan);
      // Request presentation before awaiting network or filesystem checks.
      const answer = confirm({
        kind: "merged-worktrees",
        subject: basename(repository),
        worktrees: [],
        feed: run,
      });
      try {
        run.ready(await prepare);
      } catch {
        run.failed();
      }
      if (await answer) run.act();
      const reviewed = run.current().stage === "run" && !run.pending;
      // Hide resolves presentation, but the repository reservation lasts through the run.
      await run.settled();
      if (reviewed || run.current().stage !== "run") {
        this.cleanupRuns.delete(repository);
        this.deps.refresh();
      }
    });
  }

  /** Never let remote discovery hold up local inventory or session publication. */
  private cachedMergeEligibility(repository: string, worktrees: readonly Worktree[]) {
    if (this.cleanupRuns.get(repository)?.pending)
      return this.mergeEligibility.get(repository)?.result ?? { canDeleteMerged: false };
    if (this.deps.closed() || !worktrees.some((tree) => tree.path !== repository && !tree.bare)) {
      this.mergeEligibility.delete(repository);
      return { canDeleteMerged: false };
    }
    const key = JSON.stringify(worktrees.map((tree) => [tree, this.sessionSkip(tree.path)]));
    const cached = this.mergeEligibility.get(repository);
    if (cached?.key === key && this.deps.now() < cached.expires) return cached.result;
    const entry: {
      key: string;
      count: number;
      expires: number;
      result: { canDeleteMerged: boolean; mergedCount?: number; mergedError?: string };
      plan?: readonly CleanupCandidate[];
    } = {
      key,
      count: worktrees.length,
      expires: Number.POSITIVE_INFINITY,
      result: { canDeleteMerged: false },
    };
    this.mergeEligibility.set(repository, entry);
    const publish = (result: {
      canDeleteMerged: boolean;
      mergedCount?: number;
      mergedError?: string;
    }) => {
      // A newer inventory, repository removal or shutdown supersedes this scan.
      if (this.deps.closed() || this.mergeEligibility.get(repository) !== entry) return;
      entry.result = result;
      entry.expires = this.deps.now() + 60_000;
      this.deps.onChange?.();
    };
    const scans = this.mergeScans.get(repository) ?? new Set<Promise<void>>();
    this.mergeScans.set(repository, scans);
    const scan: Promise<void> = this.mergedPlan(repository, false, worktrees)
      .then(
        (plan) => {
          entry.plan = plan;
          publish({
            canDeleteMerged: plan.some((item) => !item.reason),
            mergedCount: plan.filter((item) => !item.reason).length,
          });
        },
        (error: unknown) => {
          publish({
            canDeleteMerged: false,
            mergedError: error instanceof Error ? error.message : String(error),
          });
        },
      )
      .finally(() => {
        scans.delete(scan);
        if (scans.size === 0) this.mergeScans.delete(repository);
      });
    scans.add(scan);
    return entry.result;
  }
}
