import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ApplicationError } from "../../shared/application-errors";
import type { GitPanelFacts } from "../../shared/panel";
import type { FetchFacts } from "./worktree-features.d";
import type { PanelFactsDependencies } from "./worktree-state.d";
import { git, pickRemote } from "./worktree-operations";

/** Presentation cache only; authorization precedes every cache lookup. */
export class WorktreePanelFacts {
  private readonly panelCache = new Map<
    string,
    { time: number; identity: string; result: Promise<GitPanelFacts> }
  >();
  constructor(private readonly dependencies: PanelFactsDependencies) {}
  invalidate(): void {
    this.panelCache.clear();
  }
  /** Authorize even cache hits. Opening a panel never starts or awaits a network fetch. */
  async panelFacts(repository: string, worktree: string): Promise<GitPanelFacts> {
    let identity: string;
    try {
      identity = await this.dependencies.launchIdentity(repository, worktree);
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.code !== "worktree-prunable") throw error;
      // Known inventory state, not a failed panel operation.
      return {
        changes: null,
        upstream: null,
        commit: null,
        remote: null,
        defaultBranch: null,
        lastFetch: null,
        fetchFailed: false,
        merged: null,
      };
    }
    const key = `${repository}\0${worktree}`;
    const cached = this.panelCache.get(key);
    if (cached?.identity === identity && this.dependencies.now() - cached.time < 3000)
      return cached.result;
    const result = readPanelFacts(this.dependencies.fetchFacts, repository, worktree);
    this.panelCache.set(key, { identity, time: this.dependencies.now(), result });
    return result;
  }
}

export async function readPanelFacts(
  fetchFacts: (repository: string) => FetchFacts | undefined,
  repository: string,
  worktree: string,
): Promise<GitPanelFacts> {
  const read = (args: string[]) => git(worktree, args, 3000).catch(() => null);
  const remoteName = pickRemote((await read(["remote"])) ?? "");
  const [status, upstream, log, remote, localDefault, fetchPath] = await Promise.all([
    read(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    read(["rev-list", "--left-right", "--count", "HEAD...@{upstream}", "--"]),
    read(["log", "-1", "--format=%H%x00%s%x00%ct", "--"]),
    remoteName ? read(["remote", "get-url", "--", remoteName]) : null,
    remoteName ? read(["symbolic-ref", "--quiet", `refs/remotes/${remoteName}/HEAD`]) : null,
    read(["rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD"]),
  ]);
  let changes: number | null = null;
  if (status !== null) {
    changes = 0;
    const records = status.split("\0");
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record) continue;
      changes++;
      if (/[RC]/u.test(record.slice(0, 2))) index++;
    }
  }
  const counts = upstream?.trim().match(/^(\d+)\s+(\d+)$/u);
  const [hash, subject, seconds] = log?.trim().split("\0") ?? [];
  const fetch = fetchFacts(repository);
  const localFetch =
    fetchPath && isAbsolute(fetchPath.trim())
      ? await lstat(fetchPath.trim()).then(
          (stat) => (stat.isFile() ? stat.mtimeMs : null),
          () => null,
        )
      : null;
  const prefix = `refs/remotes/${remoteName ?? ""}/`;
  const localBranch = localDefault?.startsWith(prefix)
    ? localDefault.trim().slice(prefix.length)
    : null;
  let merged: boolean | null = null;
  if (fetch?.head && !fetch.failed && hash && /^[a-f0-9]{40,64}$/u.test(hash)) {
    const tree = await read(["rev-parse", `${fetch.head}^{tree}`]);
    const merge = await read(["merge-tree", "--write-tree", fetch.head, hash]);
    if (tree !== null && merge !== null) merged = tree.trim() === merge.trim();
  }
  return {
    changes,
    upstream: counts ? { ahead: Number(counts[1]), behind: Number(counts[2]) } : null,
    commit:
      hash &&
      subject !== undefined &&
      seconds &&
      /^[a-f0-9]{40,64}$/u.test(hash) &&
      /^\d+$/u.test(seconds)
        ? { hash, subject: subject.slice(0, 500), timestamp: Number(seconds) * 1000 }
        : null,
    remote: remote?.trim().slice(0, 4096) || null,
    defaultBranch: fetch?.branch ?? localBranch,
    lastFetch: fetch?.time ?? localFetch,
    fetchFailed: fetch?.failed ?? false,
    merged,
  };
}
