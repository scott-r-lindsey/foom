import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { ApplicationError } from "../../shared/application-errors";
import type { GitPanelFacts } from "../../shared/panel";
import type {
  BranchInventory,
  CreatedWorktree,
  CreateWorktreeOptions,
  Repository,
  Worktree,
} from "../../shared/worktrees";
import { pullRequest } from "../control/forge";
import type { ForgeProviderFactory } from "../control/forge.d";
import { fetchAdvertisedDefault } from "./fetch-default";
import { inventoryWatchPaths } from "./inventory-watch";
import {
  absolutePath,
  adoptWorktree,
  assertInside,
  createWorktree,
  forgeProviderFor,
  git,
  pickRemote,
  readPanelFacts,
  record,
  refNames,
  validatePath,
  within,
  worktreeIdentity,
} from "./worktree-operations";

/** Main-process service. Git membership authorizes management; managed records creation history. */
export class WorktreeService {
  private readonly repositories = new Map<string, Repository>();
  private readonly managed = new Map<
    string,
    { repository: string; root: string; identity: string }
  >();
  private readonly root: string;

  private stateFile: string | undefined;
  private pendingSave: Promise<void> = Promise.resolve();

  /** Call after app.whenReady(), passing app.getPath("userData"). */
  /** `protect` applies before saved repositories load, so a conflicting one is dropped. */
  static async open(
    userData: string,
    root?: string,
    protect: readonly string[] = [],
    provider: ForgeProviderFactory = () => undefined,
  ): Promise<WorktreeService> {
    validatePath(userData);
    const service = new WorktreeService(root, provider);
    for (const path of protect) await service.protect(path);
    const stateFile = join(resolve(userData), "worktrees.json");
    await service.load(stateFile);
    service.stateFile = stateFile;
    return service;
  }

  private async load(stateFile: string): Promise<void> {
    let state: unknown;
    try {
      state = JSON.parse(await readFile(stateFile, "utf8"));
    } catch {
      // Missing, unreadable or corrupt state never grants ownership or blocks startup.
      return;
    }
    if (
      !record(state) ||
      state["version"] !== 1 ||
      !Array.isArray(state["repositories"]) ||
      !Array.isArray(state["managed"])
    )
      return;
    for (const path of state["repositories"]) {
      if (!absolutePath(path)) continue;
      try {
        if ((await realpath(path)) !== path) continue;
        await this.addRepository(path);
      } catch {
        // Removed or invalid repositories are omitted.
      }
    }
    for (const entry of state["managed"]) {
      if (
        !record(entry) ||
        !absolutePath(entry["path"]) ||
        !absolutePath(entry["repository"]) ||
        !absolutePath(entry["root"]) ||
        typeof entry["identity"] !== "string"
      )
        continue;
      const { path, repository, root, identity } = entry;
      if (!this.repositories.has(repository)) continue;
      try {
        const configured = await realpath(this.root).catch(() => undefined);
        if (root !== configured && root !== dirname(repository)) continue;
        assertInside(root, path);
        if ((await realpath(path)) !== path) continue;
        if (
          !(await this.listWorktrees(repository)).some((tree) => tree.path === path && !tree.bare)
        )
          continue;
        if ((await worktreeIdentity(path)) !== identity) continue;
        this.managed.set(path, { repository, root, identity });
      } catch {
        // A stored record is only a claim: stale or redirected paths lose ownership.
      }
    }
    this.stateFile = stateFile;
    await this.save();
  }

  private async save(): Promise<void> {
    const stateFile = this.stateFile;
    if (!stateFile) return;
    const save = this.pendingSave
      .catch(() => undefined)
      .then(async () => {
        const contents = JSON.stringify({
          version: 1,
          repositories: [...this.repositories.keys()],
          managed: [...this.managed].map(([path, ownership]) => ({ path, ...ownership })),
        });
        await mkdir(dirname(stateFile), { recursive: true });
        const temporary = `${stateFile}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
          await rename(temporary, stateFile);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    this.pendingSave = save;
    await save;
  }

  constructor(
    root = join(homedir(), ".foom", "worktrees"),
    private readonly provider: ForgeProviderFactory = () => undefined,
  ) {
    validatePath(root);
    this.root = resolve(root);
  }

  private protectedPaths: string[] = [];

  /** Folders that must never sit inside a registered repository, such as Foom config. */
  async protect(path: string): Promise<void> {
    validatePath(path);
    this.protectedPaths.push(await realpath(path).catch(() => resolve(path)));
  }

  /** Whether `path` is inside (or is) a registered repository. */
  async managesPath(path: string): Promise<boolean> {
    const target = await realpath(path).catch(() => resolve(path));
    return [...this.repositories.keys()].some((repository) => within(repository, target));
  }

  private refuseProtected(path: string): void {
    if (this.protectedPaths.some((entry) => within(path, entry) || within(entry, path)))
      throw new Error("Foom config cannot be inside a repository Foom manages");
  }

  async addRepository(path: string): Promise<Repository> {
    validatePath(path);
    const cwd = await realpath(resolve(path));
    // Never run repository git commands inside the agent-writable config folder.
    this.refuseProtected(cwd);
    if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true") {
      throw new Error("Repository must be a Git work tree");
    }
    const top = await realpath((await git(cwd, ["rev-parse", "--show-toplevel"])).slice(0, -1));
    this.refuseProtected(top);
    const repository = Object.freeze({ path: top, name: basename(top) });
    this.repositories.set(top, repository);
    await this.save();
    return repository;
  }

  /** Forget registration and creation history, leaving every checkout on disk. */
  async removeRepository(path: string): Promise<void> {
    this.repository(path);
    for (const [tree, entry] of this.managed) {
      if (entry.repository === path) this.managed.delete(tree);
    }
    this.repositories.delete(path);
    await this.save();
  }

  /** Where worktrees go when they don't sit next to their repository. */
  get worktreeRoot(): string {
    return this.root;
  }

  listRepositories(): readonly Repository[] {
    return [...this.repositories.values()];
  }

  private repository(path: string): Repository {
    const repository = this.repositories.get(path);
    if (!repository) throw new Error("Repository has not been added");
    return repository;
  }

  async watchPaths(repositoryPath: string): Promise<readonly string[]> {
    this.repository(repositoryPath);
    const output = await git(repositoryPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const common = output.slice(0, -1);
    validatePath(common);
    if (!isAbsolute(common)) throw new Error("Invalid Git common directory");
    return inventoryWatchPaths(await realpath(common));
  }

  async listWorktrees(repositoryPath: string): Promise<readonly Worktree[]> {
    const repository = this.repository(repositoryPath);
    const output = await git(repository.path, ["worktree", "list", "--porcelain", "-z"]);
    return Promise.all(
      output
        .split("\0\0")
        .filter(Boolean)
        .map(async (record) => {
          const fields = record.split("\0");
          const field = (name: string): string | undefined =>
            fields.find((value) => value.startsWith(`${name} `))?.slice(name.length + 1);
          const path = field("worktree");
          const head = field("HEAD");
          const bare = fields.includes("bare");
          if (!path || (!head && !bare)) throw new Error("Invalid Git worktree record");
          return {
            path: resolve(path),
            head: head ?? null,
            bare,
            branch: field("branch")?.replace(/^refs\/heads\//u, "") ?? null,
            locked: fields.some((value) => value === "locked" || value.startsWith("locked ")),
            prunable: fields.some((value) => value === "prunable" || value.startsWith("prunable ")),
            managed: await this.isManaged(repository.path, resolve(path)),
          };
        }),
    );
  }

  private async isManaged(repository: string, path: string): Promise<boolean> {
    const ownership = this.managed.get(path);
    if (ownership?.repository !== repository) return false;
    try {
      if ((await worktreeIdentity(path)) === ownership.identity) return true;
    } catch {
      // Missing or unreadable metadata cannot establish ownership.
    }
    this.managed.delete(path);
    await this.save();
    return false;
  }

  async validateBranch(repositoryPath: string, branch: string): Promise<void> {
    this.repository(repositoryPath);
    if (!branch || branch.startsWith("-") || /[\\:\0]/u.test(branch))
      throw new Error("Invalid branch name");
    let checked: string;
    try {
      checked = await git(repositoryPath, ["check-ref-format", "--branch", branch]);
    } catch {
      throw new Error("Invalid branch name. Use a Git branch name such as feat/my-task.");
    }
    if (checked.trimEnd() !== branch) throw new Error("Branch shorthand is not allowed");
  }

  /** Main-only snapshot for an explicitly confirmed removal, including external trees. */
  async removalIdentity(repositoryPath: string, path: string): Promise<string> {
    return this.checkoutIdentity(repositoryPath, path, false);
  }

  /** Validate any selected checkout belonging to an added repository. */
  async launchIdentity(repositoryPath: string, path: string): Promise<string> {
    return this.checkoutIdentity(repositoryPath, path, true);
  }

  private async checkoutIdentity(
    repositoryPath: string,
    path: string,
    allowMain: boolean,
  ): Promise<string> {
    validatePath(path);
    const trees = await this.listWorktrees(repositoryPath);
    const tree = trees.find((item) => item.path === path);
    if (!allowMain && path === repositoryPath) throw new ApplicationError("worktree-main");
    if (!tree || tree.bare) throw new ApplicationError("worktree-missing");
    if (tree.locked) throw new ApplicationError("worktree-locked");
    if (tree.prunable) throw new ApplicationError("worktree-prunable");
    if ((await realpath(path)) !== path) throw new Error("Worktree path has been redirected");
    const commonDirectory = async (cwd: string) =>
      realpath(
        (await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).slice(0, -1),
      );
    const common = await commonDirectory(repositoryPath);
    const gitDirectory = await realpath(
      (await git(path, ["rev-parse", "--absolute-git-dir"])).slice(0, -1),
    );
    if ((!allowMain && gitDirectory === common) || (await commonDirectory(path)) !== common)
      throw new Error("Worktree is not a linked checkout of this repository");
    return worktreeIdentity(path);
  }

  /** Prune only Git's recorded checkout; no caller-selected recursive deletion. */
  async pruneWorktree(repositoryPath: string, path: string): Promise<void> {
    this.repository(repositoryPath);
    const tree = (await this.listWorktrees(repositoryPath)).find((entry) => entry.path === path);
    if (!tree || !tree.prunable || tree.locked || tree.bare || path === repositoryPath)
      throw new ApplicationError("prune-unsafe");
    const checkFolder = async (): Promise<string | undefined> => {
      try {
        assertInside(this.root, tree.path);
        // Check every component, including the root's ancestors and the final folder.
        let current = parse(tree.path).root;
        for (const part of relative(current, tree.path).split(sep)) {
          current = join(current, part);
          const entry = await lstat(current, { bigint: true }).catch((error: unknown) => {
            if (record(error) && error["code"] === "ENOENT") return undefined;
            throw error;
          });
          if (!entry) return undefined;
          if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Unsafe folder");
        }
        const root = await realpath(this.root);
        const canonical = await realpath(tree.path);
        assertInside(root, canonical);
        if (canonical !== tree.path) throw new Error("Redirected folder");
        const gitEntry = await lstat(join(tree.path, ".git")).catch((error: unknown) => {
          if (record(error) && error["code"] === "ENOENT") return undefined;
          throw error;
        });
        if (gitEntry) throw new Error("Git entry remains");
        const entry = await lstat(tree.path, { bigint: true });
        return [entry.dev, entry.ino, entry.birthtimeNs].map(String).join(":");
      } catch {
        throw new ApplicationError("prune-unsafe");
      }
    };
    const identity = await checkFolder();
    await git(repositoryPath, ["worktree", "prune"]);
    // Recheck after the subprocess; prune must never turn a new checkout into a deletion.
    if ((await checkFolder()) !== identity) throw new ApplicationError("prune-unsafe");
    if (identity !== undefined) await rm(tree.path, { recursive: true });
    this.managed.delete(tree.path);
    await this.save();
  }

  /** Broken-row cleanup never recursively deletes an uninspectable directory. */
  async cleanupBrokenWorktree(repository: string, path: string): Promise<void> {
    this.repository(repository);
    const trees = await this.listWorktrees(repository);
    const selected = trees.find((tree) => tree.path === path);
    if (!selected?.prunable || selected.locked || selected.bare || path === repository)
      throw new ApplicationError("prune-unsafe");
    assertInside(await realpath(this.root), resolve(path));
    // Prune is repository-wide. Prove every prunable admin record safe before
    // invoking it, including worktrees whose checkout directory is already gone.
    const common = (
      await git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).trimEnd();
    const validate = async () => {
      const admins = await readdir(join(common, "worktrees"));
      let found = false;
      for (const name of admins) {
        const admin = join(common, "worktrees", name);
        const checkout = resolve(
          dirname((await readFile(join(admin, "gitdir"), "utf8")).trimEnd()),
        );
        if (!trees.some((tree) => tree.prunable && tree.path === checkout)) continue;
        if (checkout === path) found = true;
        await this.checkCleanupState(repository, admin);
        const read = (args: string[]) =>
          git(repository, ["--git-dir", admin, ...cleanupReadOptions, ...args]);
        if (
          (
            await read(["config", "--bool", "--default=false", "--get", "core.sparseCheckout"])
          ).trim() !== "false"
        )
          throw new ApplicationError("prune-unsafe");
        const index = await read(["ls-files", "-v", "--stage", "-z"]);
        // Without a checkout marker there is no trustworthy status snapshot. Keep
        // any nonempty index, including staged blobs, gitlinks and sparse entries.
        if (
          index ||
          (await read(["rev-list", "--count", "HEAD", "--not", "--remotes"])).trim() !== "0"
        )
          throw new ApplicationError("prune-unsafe");
      }
      if (!found) throw new ApplicationError("prune-unsafe");
    };
    await validate();
    // rmdir is deliberately nonrecursive: new or undisclosed contents fail closed.
    // Reuse the canonical/symlink/marker guards of prune without its rm path by
    // first requiring the directory to be absent. Only an empty directory may go.
    if (await exists(path)) {
      if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory())
        throw new ApplicationError("prune-unsafe");
      await rmdir(path);
    }
    await validate();
    await git(repository, ["worktree", "prune"]);
    this.managed.delete(path);
    await this.save();
  }

  private async checkRemovalIdentity(
    repositoryPath: string,
    path: string,
    identity: string,
  ): Promise<void> {
    if ((await this.removalIdentity(repositoryPath, path)) !== identity)
      throw new Error("Worktree has been replaced. Review it and try again.");
  }

  // Background status reads must not refresh/write the index while removal is
  // deleting per-worktree Git metadata. --no-optional-locks keeps them read-only.
  // Disable status caches so they cannot hide changes from a removal snapshot.
  async changes(repositoryPath: string, path: string, identity?: string): Promise<string> {
    const expected = identity ?? (await this.removalIdentity(repositoryPath, path));
    await this.checkRemovalIdentity(repositoryPath, path, expected);
    return git(path, [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
  }

  /** A fresh config-neutral status snapshot for group cleanup, never explicit removal. */
  async cleanupStatus(
    repository: string,
    path: string,
    identity?: string,
    head?: string | null,
  ): Promise<string> {
    const expected = identity ?? (await this.removalIdentity(repository, path));
    const read = (args: string[]) => git(path, [...cleanupReadOptions, ...args]);
    const expectedHead = head ?? (await read(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    const sparse = (
      await read(["config", "--bool", "--default=false", "--get", "core.sparseCheckout"])
    ).trim();
    if (sparse !== "false") throw new Error("Sparse checkouts prevent cleanup");
    const index = await read(["ls-files", "-v", "--stage", "-z", "--"]);
    const entries = index.split("\0").filter(Boolean);
    if (entries.some((entry) => /^[a-zS]/.test(entry)))
      throw new Error("Index flags can hide tracked changes and prevent cleanup");
    if (
      entries.some((entry) => entry.slice(2).startsWith("160000 ")) ||
      (await exists(join(path, ".gitmodules")))
    )
      throw new Error("Submodules prevent cleanup");
    await this.checkCleanupState(path);
    const changes = await read([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--ignore-submodules=none",
    ]);
    const records = changes.split("\0").filter(Boolean);
    // A case-sensitive read exposes names hidden by core.ignorecase. Refuse
    // collisions rather than interpreting which spelling represents tracked data.
    const tracked = new Set(
      entries.map((entry) => entry.slice(entry.indexOf("\t") + 1).toLowerCase()),
    );
    if (
      records.some(
        (entry) =>
          (entry.startsWith("?? ") || entry.startsWith("!! ")) &&
          tracked.has(entry.slice(3).toLowerCase()),
      )
    )
      throw new Error("Case-colliding paths prevent cleanup");
    if ((await read(["ls-files", "-v", "--stage", "-z", "--"])) !== index)
      throw new Error("Index changed during cleanup checks");
    await this.checkRemovalIdentity(repository, path, expected);
    if ((await read(["rev-parse", "--verify", "HEAD^{commit}"])).trim() !== expectedHead)
      throw new Error("HEAD changed during cleanup checks");
    return changes;
  }

  private async checkCleanupState(path: string, gitDirectory?: string): Promise<void> {
    const read = (args: string[]) =>
      git(path, [
        ...(gitDirectory ? ["--git-dir", gitDirectory] : []),
        ...cleanupReadOptions,
        ...args,
      ]);
    if (
      (
        await read([
          "for-each-ref",
          "--format=%(refname)",
          "refs/worktree/",
          "refs/bisect/",
          "refs/rewritten/",
        ])
      ).trim()
    )
      throw new Error("Worktree-private refs prevent cleanup");
    const names = [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
      "BISECT_LOG",
      "BISECT_START",
    ];
    const paths = (
      await read([
        "rev-parse",
        "--path-format=absolute",
        ...names.flatMap((name) => ["--git-path", name]),
      ])
    )
      .trimEnd()
      .split("\n");
    if (paths.length !== names.length) throw new Error("Cannot inspect Git operation state");
    if ((await Promise.all(paths.map(exists))).some(Boolean))
      throw new Error("An in-progress Git operation prevents cleanup");
  }

  /** Extra guards for newly eligible detached and leftover-only cleanup. */
  async cleanupChanges(
    repository: string,
    path: string,
    identity?: string,
    head?: string | null,
  ): Promise<string> {
    const expected = identity ?? (await this.removalIdentity(repository, path));
    assertInside(await realpath(this.root), await realpath(path));
    const changes = await this.cleanupStatus(repository, path, expected, head);
    if (
      changes
        .split("\0")
        .some((entry) => entry && !entry.startsWith("?? ") && !entry.startsWith("!! "))
    )
      throw new Error("Tracked changes prevent cleanup");
    const unpushed = (
      await git(path, ["rev-list", "--count", "HEAD", "--not", "--remotes", "--"])
    ).trim();
    if (unpushed !== "0") throw new Error("Unpushed commits prevent cleanup");
    await this.checkRemovalIdentity(repository, path, expected);
    if (head && (await git(path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim() !== head)
      throw new Error("HEAD changed during cleanup checks");
    return changes;
  }

  /** Local refs only: the branch field never waits on the network. */
  async branches(repositoryPath: string): Promise<BranchInventory> {
    const repository = this.repository(repositoryPath);
    const [head, locals, remotes, trees] = await Promise.all([
      git(repository.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then(
        (output) => output.trim() || null,
        () => null,
      ),
      git(repository.path, ["for-each-ref", "--format=%(refname)", "--", "refs/heads/"]),
      git(repository.path, ["remote"]),
      this.listWorktrees(repository.path),
    ]);
    const remote = pickRemote(remotes);
    const remoteRefs = remote
      ? await git(repository.path, [
          "for-each-ref",
          "--format=%(refname)",
          "--",
          `refs/remotes/${remote}/`,
        ])
      : "";
    return {
      head,
      local: refNames(locals, "refs/heads/").map((name) => ({
        name,
        worktree: trees.find((tree) => tree.branch === name)?.path ?? null,
      })),
      remote: remote ?? null,
      remoteBranches: refNames(remoteRefs, `refs/remotes/${remote ?? ""}/`).filter(
        (name) => name !== "HEAD",
      ),
    };
  }

  private async forgeProviderFor(repository: string, path: string, remote: string) {
    return forgeProviderFor(
      this,
      this.provider,
      this.repository.bind(this),
      repository,
      path,
      remote,
    );
  }

  /** Only main-owned unused checkouts can be reused; no caller supplies a remote or path. */
  async adoptWorktree(
    repositoryPath: string,
    number: number,
    unused: readonly { path: string; identity: string }[],
    revalidate: (path?: string, branch?: string) => void,
    location: "root" | "adjacent" = "root",
  ): Promise<{ path: string; branch: string; identity: string }> {
    this.repository(repositoryPath);
    return adoptWorktree(
      this,
      this.forgeProviderFor.bind(this),
      repositoryPath,
      number,
      unused,
      revalidate,
      location,
    );
  }

  /** Create or reuse a checkout after validating the repository and branch. */
  async createWorktree(
    repositoryPath: string,
    branch: string,
    options: CreateWorktreeOptions = {},
  ): Promise<CreatedWorktree> {
    return createWorktree(
      {
        root: this.root,
        managed: this.managed,
        repository: this.repository.bind(this),
        validateBranch: this.validateBranch.bind(this),
        listWorktrees: this.listWorktrees.bind(this),
        save: this.save.bind(this),
      },
      repositoryPath,
      branch,
      options,
    );
  }

  private readonly panelCache = new Map<
    string,
    { time: number; identity: string; result: Promise<GitPanelFacts> }
  >();
  private readonly fetchFacts = new Map<
    string,
    { branch: string | null; time: number; failed: boolean; head: string | null }
  >();

  /** Local remote metadata only; no fetch or credential lookup. */
  async forgeRemote(repository: string): Promise<string | undefined> {
    const remote = pickRemote(await git(repository, ["remote"]));
    if (!remote) return undefined;
    return (await git(repository, ["config", "--get", `remote.${remote}.url`])).trim();
  }

  /** Authorize even cache hits. Opening a panel never starts or awaits a network fetch. */
  async panelFacts(repository: string, worktree: string): Promise<GitPanelFacts> {
    let identity: string;
    try {
      identity = await this.launchIdentity(repository, worktree);
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
    if (cached?.identity === identity && Date.now() - cached.time < 3000) return cached.result;
    const result = readPanelFacts(this.fetchFacts, repository, worktree);
    this.panelCache.set(key, { identity, time: Date.now(), result });
    return result;
  }

  private readonly mergeDefaults = new Map<string, { time: number; result: Promise<string> }>();

  /** Inventory shares a recent fetch; destructive actions always fetch again. */
  async mergedDefault(repository: string, refresh = false): Promise<string> {
    this.repository(repository);
    const cached = this.mergeDefaults.get(repository);
    if (!refresh && cached && Date.now() - cached.time < 60_000) return cached.result;
    const result = (cached?.result.catch(() => undefined) ?? Promise.resolve()).then(() =>
      this.fetchDefault(repository),
    );
    this.mergeDefaults.set(repository, { time: Date.now(), result });
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
        (branch) => this.validateBranch(repository, branch),
      );
      this.fetchFacts.set(repository, {
        branch,
        time: Date.now(),
        failed: false,
        head: commit,
      });
      this.panelCache.clear();
      return commit;
    } catch (error) {
      this.fetchFacts.set(repository, { branch: null, time: Date.now(), failed: true, head: null });
      this.panelCache.clear();
      throw new Error(
        `Cannot check merged worktrees: fetch failed. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /** Ancestry or a PR merge verified against the freshly fetched default. */
  async canAutoRemove(repository: string, path: string, identity: string): Promise<boolean> {
    try {
      await this.checkRemovalIdentity(repository, path, identity);
      const base = await this.mergedDefault(repository, true);
      const branch = (await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
      await this.validateBranch(repository, branch);
      const head = (await git(path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
      if (!/^[a-f0-9]{40,64}$/u.test(head) || !/^[a-f0-9]{40,64}$/u.test(base)) return false;
      if (this.fetchFacts.get(repository)?.branch === branch) return false;
      const tree = (await this.listWorktrees(repository)).find((item) => item.path === path);
      if (!tree || tree.head !== head || tree.branch !== branch) return false;
      if (!(await this.verifiedPrMerge(repository, tree, base))) {
        // Preserve the no-unpushed-commits guard for the ancestry-only path.
        const upstream = (
          await git(path, ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`])
        ).trim();
        const unpushed = (
          await git(
            path,
            upstream
              ? ["rev-list", "--count", "HEAD", "--not", upstream, "--"]
              : ["rev-list", "--count", "HEAD", "--not", "--remotes", "--"],
          )
        ).trim();
        if (unpushed !== "0") return false;
        await git(path, ["merge-base", "--is-ancestor", head, base]);
      }
      if ((await this.changes(repository, path, identity)) !== "") return false;
      return (
        (await git(path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim() === head &&
        (await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() === branch
      );
    } catch {
      // Missing refs, failed fetches, unsupported Git and identity changes never authorize removal.
      return false;
    }
  }

  async mergedCommit(repository: string, tree: Worktree, base: string): Promise<boolean> {
    if (
      !tree.head ||
      (tree.branch !== null && this.fetchFacts.get(repository)?.branch === tree.branch)
    )
      return false;
    if (tree.branch) await this.validateBranch(repository, tree.branch);
    if (!/^[a-f0-9]{40,64}$/u.test(base) || !/^[a-f0-9]{40,64}$/u.test(tree.head))
      throw new Error("Invalid commit ID");
    const defaultTree = (await git(repository, ["rev-parse", `${base}^{tree}`])).trim();
    try {
      if (
        (await git(repository, ["merge-tree", "--write-tree", base, tree.head])).trim() ===
        defaultTree
      )
        return true;
    } catch {
      // A content conflict does not rule out an earlier PR merge.
    }
    return this.verifiedPrMerge(repository, tree, base);
  }

  /** Forge output is only a hint; never pass its unchecked values to Git. */
  private async verifiedPrMerge(
    repository: string,
    tree: Worktree,
    base: string,
  ): Promise<boolean> {
    try {
      if (!tree.branch || !tree.head || this.fetchFacts.get(repository)?.branch === tree.branch)
        return false;
      const remote = await this.forgeRemote(repository);
      const pr = pullRequest(
        await (remote === undefined
          ? undefined
          : (await this.forgeProviderFor(repository, tree.path, remote))?.lookup(
              tree.branch,
              undefined,
              "all",
            )),
      );
      if (pr?.state !== "MERGED" || pr.headSha !== tree.head || !pr.mergeCommit) return false;
      await git(repository, ["merge-base", "--is-ancestor", pr.mergeCommit, base]);
      return (
        (await git(tree.path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim() === tree.head &&
        (await this.changes(repository, tree.path)) === ""
      );
    } catch {
      // Missing objects, malformed/hostile forge hints and unavailable providers fail closed.
      return false;
    }
  }

  async deleteMergedBranch(repository: string, branch: string, head: string): Promise<void> {
    await this.validateBranch(repository, branch);
    if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error("Invalid commit ID");
    if ((await this.listWorktrees(repository)).some((tree) => tree.branch === branch))
      throw new Error("Branch is checked out; kept its local ref");
    // Compare-and-delete atomically, unlike branch -D's unconditional ref deletion.
    // This also removes squash-merged refs without an ancestry-based merged check.
    await git(repository, ["update-ref", "--no-deref", "-d", `refs/heads/${branch}`, head]);
  }

  async deleteMergedBranches(
    repository: string,
    branches: readonly { branch: string; head: string }[],
  ): Promise<readonly string[]> {
    const checkedOut = new Set((await this.listWorktrees(repository)).map((tree) => tree.branch));
    const kept: string[] = [];
    const commands: string[] = [];
    for (const { branch, head } of branches) {
      await this.validateBranch(repository, branch);
      if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error("Invalid commit ID");
      const current = await git(repository, [
        "rev-parse",
        "--verify",
        `refs/heads/${branch}`,
      ]).catch(() => "");
      if (checkedOut.has(branch) || current.trim() !== head) kept.push(branch);
      else commands.push(`delete refs/heads/${branch} ${head}`);
    }
    if (commands.length) {
      // One transaction locks refs together. A race aborts it; preserve every ref on failure.
      try {
        await git(
          repository,
          ["update-ref", "--no-deref", "--stdin"],
          30_000,
          ["start", ...commands, "prepare", "commit", ""].join("\n"),
        );
      } catch {
        return branches.map((item) => item.branch);
      }
    }
    return kept;
  }

  async removeWorktree(
    repositoryPath: string,
    path: string,
    force = false,
    identity?: string,
    beforeRemove?: () => Promise<void>,
  ): Promise<void> {
    const repository = this.repository(repositoryPath);
    validatePath(path);
    const resolved = resolve(path);
    const expected = identity ?? (await this.removalIdentity(repositoryPath, resolved));
    await this.checkRemovalIdentity(repositoryPath, resolved, expected);
    // Callers with an approved snapshot must validate after the identity await,
    // immediately before Git. Direct callers keep Git's existing dirty policy.
    await beforeRemove?.();
    // Git performs its own dirty/locked checks before removing the tree.
    await git(repository.path, [
      "worktree",
      "remove",
      ...(force ? ["--force"] : []),
      "--",
      resolved,
    ]);
    this.managed.delete(resolved);
    await this.save();
  }
}

// Command-scoped overrides: repository configuration cannot suppress evidence.
const cleanupReadOptions = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.ignorecase=false",
  "-c",
  "diff.ignoreSubmodules=none",
  "-c",
  "status.showUntrackedFiles=all",
];
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: unknown) => {
      if (record(error) && error["code"] === "ENOENT") return false;
      throw error;
    },
  );
}
