import { RemovalError } from "./worktree-outcome";
import { lstat, opendir, readFile, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { readOwnedFile } from "../../node-common/owned-files";
import { ApplicationError } from "../../shared/application-errors";
import type { GitPanelFacts } from "../../shared/panel";
import type {
  BranchInventory,
  CreatedWorktree,
  CreateWorktreeOptions,
  Repository,
  Worktree,
} from "../../shared/worktrees";
import type { ForgeProviderFactory } from "../control/forge.d";
import { inventoryWatchPaths } from "./inventory-watch";
import {
  adoptWorktree,
  assertInside,
  createWorktree,
  forgeProviderFor,
  git,
  pickRemote,
  record,
  refNames,
  validatePath,
  within,
} from "./worktree-operations";
import { WorktreeStore } from "./worktree-store";
import { checkoutIdentity, worktreeIdentity } from "./worktree-identity";
import { WorktreeFetchState } from "./worktree-fetch-state";
import { WorktreePanelFacts } from "./worktree-panel-facts";
import { WorktreeMergePolicy } from "./worktree-merge-policy";
import { WorktreeBranchCleanup } from "./worktree-branch-cleanup";

/** Main-process service. Git membership authorizes management; managed records creation history. */
export class WorktreeService {
  private readonly repositories = new Map<string, Repository>();
  private readonly managed = new Map<
    string,
    { repository: string; root: string; identity: string }
  >();
  private readonly root: string;

  private store: WorktreeStore | undefined;
  private async save(): Promise<void> {
    await this.store?.save(() => ({
      version: 1,
      repositories: [...this.repositories.keys()],
      managed: [...this.managed].map(([path, ownership]) => ({ path, ...ownership })),
    }));
  }

  private readonly panels = new WorktreePanelFacts({
    launchIdentity: (repository, path) => this.launchIdentity(repository, path),
    fetchFacts: (repository) => this.fetchState.facts(repository),
    now: () => Date.now(),
  });
  private readonly fetchState = new WorktreeFetchState({
    repository: (path) => this.repository(path),
    validateBranch: (repository, branch) => this.validateBranch(repository, branch),
    invalidatePanels: () => {
      this.panels.invalidate();
    },
    now: () => Date.now(),
  });
  private readonly mergePolicy = new WorktreeMergePolicy({
    checkRemovalIdentity: (repository, path, identity) =>
      this.checkRemovalIdentity(repository, path, identity),
    mergedDefault: (repository, refresh) => this.mergedDefault(repository, refresh),
    validateBranch: (repository, branch) => this.validateBranch(repository, branch),
    listWorktrees: (repository) => this.listWorktrees(repository),
    changes: (repository, path, identity) => this.changes(repository, path, identity),
    forgeRemote: (repository) => this.forgeRemote(repository),
    forgeProviderFor: (repository, path, remote) => this.forgeProviderFor(repository, path, remote),
    fetchFacts: (repository) => this.fetchState.facts(repository),
  });
  private readonly branchCleanup = new WorktreeBranchCleanup({
    validateBranch: (repository, branch) => this.validateBranch(repository, branch),
    listWorktrees: (repository) => this.listWorktrees(repository),
  });

  async panelFacts(repository: string, worktree: string): Promise<GitPanelFacts> {
    return this.panels.panelFacts(repository, worktree);
  }
  async mergedDefault(repository: string, refresh = false): Promise<string> {
    return this.fetchState.mergedDefault(repository, refresh);
  }
  mergedFetchTime(repository: string): number | undefined {
    return this.fetchState.mergedFetchTime(repository);
  }
  async canAutoRemove(repository: string, path: string, identity: string): Promise<boolean> {
    return this.mergePolicy.canAutoRemove(repository, path, identity);
  }
  async mergedCommit(repository: string, tree: Worktree, base: string): Promise<boolean> {
    return this.mergePolicy.mergedCommit(repository, tree, base);
  }
  async deleteMergedBranch(repository: string, branch: string, head: string): Promise<void> {
    return this.branchCleanup.deleteMergedBranch(repository, branch, head);
  }
  async deleteMergedBranches(
    repository: string,
    branches: readonly { branch: string; head: string }[],
  ): Promise<readonly string[]> {
    return this.branchCleanup.deleteMergedBranches(repository, branches);
  }

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
    service.store = new WorktreeStore(stateFile);
    return service;
  }

  private async load(stateFile: string): Promise<void> {
    const store = new WorktreeStore(stateFile);
    const state = await store.read();
    if (!state) return;
    for (const path of state["repositories"]) {
      try {
        if ((await realpath(path)) !== path) continue;
        await this.addRepository(path);
      } catch {
        // Removed or invalid repositories are omitted.
      }
    }
    for (const entry of state["managed"]) {
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
    this.store = store;
    await this.save();
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
    return checkoutIdentity(
      { listWorktrees: this.listWorktrees.bind(this), git, validatePath, realpath },
      repositoryPath,
      path,
      false,
    );
  }

  /** Validate any selected checkout belonging to an added repository. */
  async launchIdentity(repositoryPath: string, path: string): Promise<string> {
    return checkoutIdentity(
      { listWorktrees: this.listWorktrees.bind(this), git, validatePath, realpath },
      repositoryPath,
      path,
      true,
    );
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
      await cleanupGit(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
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
        await this.checkCleanupEvidence(repository, admin);
        const read = (args: string[]) => cleanupGit(repository, ["--git-dir", admin, ...args]);
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
      await walkCleanupDirectory(path, true);
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
      throw new RemovalError("identity_changed");
    const tree = (await this.listWorktrees(repositoryPath)).find((item) => item.path === path);
    if (tree?.branch === null) {
      const refs = await git(path, [
        "-c",
        "core.commitGraph=false",
        "for-each-ref",
        "--contains=HEAD",
        "--format=%(refname)",
      ]);
      if (!refs.trim()) throw new RemovalError("detached_head");
    }
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
    inspectReflogs = false,
  ): Promise<string> {
    const expected = identity ?? (await this.removalIdentity(repository, path));
    const read = (args: string[]) => cleanupGit(path, args);
    const expectedHead = head ?? (await read(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
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
    await this.checkCleanupEvidence(path, undefined, inspectReflogs);
    await walkCleanupDirectory(path, true);
    const paths = entries.map((entry) => entry.slice(entry.indexOf("\t") + 1));
    if (paths.length) {
      const attributes = (
        await cleanupGit(
          path,
          ["check-attr", "-z", "--stdin", "ident", "working-tree-encoding"],
          `${paths.join("\0")}\0`,
        )
      ).split("\0");
      if (attributes.pop() !== "" || attributes.length !== paths.length * 6)
        throw new Error("Cannot inspect tracked content conversions");
      for (let position = 0; position < attributes.length; position += 3) {
        const attribute = attributes[position + 1];
        const value = attributes[position + 2];
        if (
          (attribute !== "ident" && attribute !== "working-tree-encoding") ||
          (value !== "unspecified" && value !== "unset")
        )
          throw new Error("Tracked content conversions prevent cleanup");
      }
    }
    if ((await read(["ls-files", "-v", "--stage", "-z", "--"])) !== index)
      throw new Error("Index changed during cleanup checks");
    await this.checkRemovalIdentity(repository, path, expected);
    if ((await read(["rev-parse", "--verify", "HEAD^{commit}"])).trim() !== expectedHead)
      throw new Error("HEAD changed during cleanup checks");
    // Keep status last: a tracked save during any preceding validation await
    // must be visible to the approved-snapshot comparison next to Git removal.
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
    const tracked = new Set(paths.map((path) => path.toLowerCase()));
    if (
      records.some(
        (entry) =>
          (entry.startsWith("?? ") || entry.startsWith("!! ")) &&
          tracked.has(entry.slice(3).toLowerCase()),
      )
    )
      throw new Error("Case-colliding paths prevent cleanup");
    return changes;
  }

  /** New cleanup reads cannot redirect status; additional candidates must retain private history. */
  private async checkCleanupEvidence(
    path: string,
    gitDirectory?: string,
    inspectReflogs = true,
  ): Promise<void> {
    const read = (args: string[]) =>
      cleanupGit(path, [...(gitDirectory ? ["--git-dir", gitDirectory] : []), ...args]);
    const locations = gitDirectory
      ? [gitDirectory]
      : (await read(["rev-parse", "--absolute-git-dir", "--show-toplevel"])).trimEnd().split("\n");
    const admin = locations[0];
    if (!admin || (!gitDirectory && locations.length !== 2))
      throw new Error("Cannot inspect cleanup directory");
    if (await exists(join(admin, "config.worktree")))
      throw new Error("Worktree configuration prevents cleanup");
    const config = await read(["config", "--null", "--list"]);
    const settings = config
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const newline = entry.indexOf("\n");
        return {
          key: (newline < 0 ? entry : entry.slice(0, newline)).toLowerCase(),
          value: newline < 0 ? undefined : entry.slice(newline + 1),
        };
      });
    const disabled = (value: string | undefined) =>
      value !== undefined && ["", "0", "no", "off", "false"].includes(value.trim().toLowerCase());
    if (settings.some(({ key, value }) => key === "core.sparsecheckout" && !disabled(value)))
      throw new Error("Sparse checkouts prevent cleanup");
    if (
      settings.some(
        ({ key, value }) =>
          key === "core.worktree" ||
          key.startsWith("filter.") ||
          (key === "extensions.worktreeconfig" && !disabled(value)) ||
          (key === "core.bare" && !disabled(value)),
      )
    )
      throw new Error("Repository configuration prevents cleanup");
    if (!gitDirectory) {
      const top = locations[1];
      if (!top || (await realpath(top)) !== path)
        throw new Error("Cleanup directory is redirected");
    }
    // Ordinary clean branch cleanup retains its established merge-evidence policy.
    // Detached/leftover cleanup and broken-row pruning additionally protect reflogs.
    if (!inspectReflogs) return;
    const logs = join(admin, "logs");
    // A missing HEAD log is not evidence of an empty history (logging can be disabled).
    const files = await walkCleanupDirectory(logs, false);
    if (!files.includes(join(logs, "HEAD"))) throw new Error("Missing worktree HEAD reflog");
    const commits = new Set<string>();
    let remaining = 4 * 1024 * 1024;
    for (const file of files) {
      const contents = await readOwnedFile(file, remaining, async (target) => {
        const entry = await lstat(target);
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Unsafe reflog");
      });
      remaining -= Buffer.byteLength(contents);
      if (!contents || !contents.endsWith("\n")) throw new Error("Incomplete worktree reflog");
      for (const line of contents.trimEnd().split("\n")) {
        const match = /^([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) /.exec(line);
        if (!match || match[1]?.length !== match[2]?.length)
          throw new Error("Invalid worktree reflog");
        for (const oid of match.slice(1)) if (!/^0+$/.test(oid)) commits.add(oid);
      }
    }
    // Bound argument size on Windows as well as the filesystem reads above.
    const revisions = [...commits];
    for (let start = 0; start < revisions.length; start += 128) {
      if (
        (
          await read([
            "rev-list",
            "--count",
            ...revisions.slice(start, start + 128),
            "--not",
            "--remotes",
            "--",
          ])
        ).trim() !== "0"
      )
        throw new Error("Unpushed worktree reflog commits prevent cleanup");
    }
  }

  private async checkCleanupState(path: string, gitDirectory?: string): Promise<void> {
    const read = (args: string[]) =>
      cleanupGit(path, [...(gitDirectory ? ["--git-dir", gitDirectory] : []), ...args]);
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
    const expectedHead =
      head ?? (await cleanupGit(path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    assertInside(await realpath(this.root), await realpath(path));
    const unpushed = (
      await cleanupGit(path, ["rev-list", "--count", "HEAD", "--not", "--remotes", "--"])
    ).trim();
    if (unpushed !== "0") throw new Error("Unpushed commits prevent cleanup");
    const changes = await this.cleanupStatus(repository, path, expected, expectedHead, true);
    // No asynchronous work after cleanupStatus's final status read.
    if (
      changes
        .split("\0")
        .some((entry) => entry && !entry.startsWith("?? ") && !entry.startsWith("!! "))
    )
      throw new Error("Tracked changes prevent cleanup");
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

  /** Local remote metadata only; no fetch or credential lookup. */
  async forgeRemote(repository: string): Promise<string | undefined> {
    const remote = pickRemote(await git(repository, ["remote"]));
    if (!remote) return undefined;
    return (await git(repository, ["config", "--get", `remote.${remote}.url`])).trim();
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
    if (!force) {
      const changes = await this.changes(repositoryPath, resolved, expected);
      if (changes) throw new RemovalError(changes.startsWith("?? ") ? "untracked_files" : "dirty");
    }
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
  "core.ignoreStat=false",
  "-c",
  "core.trustctime=true",
  "-c",
  "core.checkStat=default",
  "-c",
  "core.fileMode=true",
  "-c",
  "core.symlinks=true",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.eol=lf",
  "-c",
  "core.attributesFile=",
  "-c",
  "core.commitGraph=false",
  "-c",
  "diff.ignoreSubmodules=none",
  "-c",
  "status.showUntrackedFiles=all",
];
// Source-local configuration still applies and is audited above; user/system
// configuration and system attributes cannot change these cleanup-only reads.
function cleanupGit(path: string, args: string[], input?: string): Promise<string> {
  return git(path, [...cleanupReadOptions, ...args], 30_000, input, true);
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: unknown) => {
      if (record(error) && error["code"] === "ENOENT") return false;
      throw error;
    },
  );
}

/** Stream a bounded tree without following symlinks, including ignored directories. */
async function walkCleanupDirectory(root: string, checkout: boolean): Promise<string[]> {
  const files: string[] = [];
  let remaining = 10_000;
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > 64 || --remaining < 0) throw new Error("Cleanup directory walk exceeded its limit");
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error("Unsafe cleanup directory");
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (--remaining < 0) throw new Error("Cleanup directory walk exceeded its limit");
      // Dirent strings replace invalid filename bytes. Never inspect a different
      // sibling through a lossy name (including a literal replacement character).
      if (
        entry.name.includes("\ufffd") ||
        Buffer.from(entry.name, "utf8").toString("utf8") !== entry.name
      )
        throw new Error("Cannot inspect cleanup directory names");
      if (entry.name.toLowerCase() === ".git") {
        if (checkout && depth === 0) continue;
        throw new Error("Nested repositories prevent cleanup");
      }
      const child = join(path, entry.name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) {
        if (!checkout) throw new Error("Symlinked reflogs prevent cleanup");
      } else if (info.isDirectory()) await walk(child, depth + 1);
      else if (info.isFile()) files.push(child);
      else throw new Error("Special files prevent cleanup");
    }
    const after = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs)
      throw new Error("Cleanup directory changed during inspection");
  };
  await walk(root, 0);
  return files;
}
