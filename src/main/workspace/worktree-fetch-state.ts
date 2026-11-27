import { fetchAdvertisedDefault } from "./fetch-default";
import { git, pickRemote } from "./worktree-operations";
import type { FetchFacts } from "./worktree-features.d";
import type { FetchStateDependencies } from "./worktree-state.d";

/** Fetch history and per-repository network sequencing; independent of panel TTL. */
export class WorktreeFetchState {
  private readonly fetchFacts = new Map<string, FetchFacts>();
  constructor(private readonly dependencies: FetchStateDependencies) {}
  facts(repository: string): FetchFacts | undefined {
    return this.fetchFacts.get(repository);
  }
  private readonly mergeDefaults = new Map<string, { time: number; result: Promise<string> }>();

  /** Inventory shares a recent fetch; destructive actions always fetch again. */
  async mergedDefault(repository: string, refresh = false): Promise<string> {
    this.dependencies.repository(repository);
    const cached = this.mergeDefaults.get(repository);
    if (!refresh && cached && this.dependencies.now() - cached.time < 60_000) return cached.result;
    const result = (cached?.result.catch(() => undefined) ?? Promise.resolve()).then(() =>
      this.fetchDefault(repository),
    );
    this.mergeDefaults.set(repository, { time: this.dependencies.now(), result });
    return result;
  }

  /** Timestamp of the successful fetch used by merged-worktree checks. */
  mergedFetchTime(repository: string): number | undefined {
    const fetch = this.fetchFacts.get(repository);
    return fetch && !fetch.failed ? fetch.time : undefined;
  }

  private async fetchDefault(repository: string): Promise<string> {
    const remote = pickRemote(await git(repository, ["remote"]));
    if (!remote) throw new Error("No unambiguous repository remote");
    try {
      const { branch, commit } = await fetchAdvertisedDefault(
        remote,
        (args) => git(repository, args),
        (branch) => this.dependencies.validateBranch(repository, branch),
      );
      this.fetchFacts.set(repository, {
        branch,
        time: this.dependencies.now(),
        failed: false,
        head: commit,
      });
      this.dependencies.invalidatePanels();
      return commit;
    } catch (error) {
      this.fetchFacts.set(repository, {
        branch: null,
        time: this.dependencies.now(),
        failed: true,
        head: null,
      });
      this.dependencies.invalidatePanels();
      throw new Error(
        `Cannot check merged worktrees: fetch failed. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}
