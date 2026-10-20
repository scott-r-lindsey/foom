import type { ForgeProviderFactory } from "../control/forge.d";
import { UncertainEffect } from "../control/orchestration-mutations";
import { forgeBranch, pullRequest } from "../control/forge";
import { ControlError } from "../../node-common/control-validation";
import { fetchAdvertisedDefault } from "./fetch-default";
import type { GitPanelFacts } from "../../shared/panel";
import { inventoryWatchPaths } from "./inventory-watch";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  BranchInventory,
  CreatedWorktree,
  CreateWorktreeOptions,
  Repository,
  Worktree,
} from "../../shared/worktrees";

const execute = promisify(execFile);

async function git(cwd: string, args: string[], timeout = 30_000, input?: string): Promise<string> {
  // Ignore inherited repository selectors: the validated cwd selects the repository.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const operation = execute("git", args, {
    cwd,
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  operation.child.stdin?.end(input);
  const { stdout } = await operation;
  return stdout;
}

function validatePath(path: string): void {
  if (!path || path.includes("\0")) throw new Error("Invalid path");
}

/** Whether `path` is `root` or inside it. */
function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function assertInside(root: string, path: string): void {
  const child = relative(root, path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Worktree path must stay inside its allowed root");
  }
}

// Walk one component at a time so an existing symlink cannot redirect mkdir
// outside the allowed root, even when the remaining parent directories are new.
async function prepareParent(root: string, path: string): Promise<void> {
  assertInside(root, path);
  let current = root;
  for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) {
    current = join(current, part);
    await mkdir(current, { recursive: true });
    const canonical = await realpath(current);
    assertInside(root, canonical);
    if (canonical !== current) throw new Error("Worktree parent has been redirected");
  }
  // Reject an existing destination, including empty directories and symlinks.
  await mkdir(path);
}

// Bind confirmation to both the filesystem entries and Git's per-worktree metadata.
// Birth time distinguishes recreated entries even when the filesystem reuses an inode.
async function worktreeIdentity(path: string): Promise<string> {
  const gitDirectory = await realpath(
    (await git(path, ["rev-parse", "--absolute-git-dir"])).slice(0, -1),
  );
  const entries = await Promise.all(
    [path, join(path, ".git"), gitDirectory].map(async (entry) => {
      const stat = await lstat(entry, { bigint: true });
      return [stat.dev, stat.ino, stat.birthtimeNs].map(String);
    }),
  );
  return JSON.stringify([gitDirectory, entries]);
}

/** The repository's remote: origin, or its only remote. */
function pickRemote(output: string): string | undefined {
  const remotes = output.trim().split("\n").filter(Boolean);
  const remote = remotes.includes("origin")
    ? "origin"
    : remotes.length === 1
      ? remotes[0]
      : undefined;
  // A remote name becomes part of a ref pattern and an argument; refuse anything unusual.
  return remote && !remote.startsWith("-") && !/[\0-\x20\x7f~^:?*[\\]/u.test(remote)
    ? remote
    : undefined;
}

/** Ref names under `prefix`, without it. Git output is bounded before it reaches the renderer. */
function refNames(output: string, prefix: string): string[] {
  return (
    output
      .split("\n")
      .filter((line) => line.startsWith(prefix) && line.length - prefix.length <= 255)
      .map((line) => line.slice(prefix.length))
      // Git refuses control characters and spaces in ref names; drop anything else it lists.
      .filter((name) => name && !/[\0-\x20\x7f]/u.test(name))
      .slice(0, 5000)
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    resolve(value) === value
  );
}

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
    if (
      !tree ||
      tree.bare ||
      tree.locked ||
      tree.prunable ||
      (!allowMain && path === repositoryPath)
    )
      throw new Error("Worktree is missing, locked, prunable, or is the main checkout");
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
  async changes(repositoryPath: string, path: string, identity?: string): Promise<string> {
    const expected = identity ?? (await this.removalIdentity(repositoryPath, path));
    await this.checkRemovalIdentity(repositoryPath, path, expected);
    return git(path, [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
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
    return this.provider(remote, async () => {
      const identity = await this.launchIdentity(repository, path);
      const branch = (await this.listWorktrees(repository)).find(
        (row) => row.path === path,
      )?.branch;
      return {
        identity: JSON.stringify([repository, path, identity, branch, remote]),
        validate: async () => {
          this.repository(repository);
          if (
            (await this.launchIdentity(repository, path)) !== identity ||
            (await this.listWorktrees(repository)).find((row) => row.path === path)?.branch !==
              branch ||
            (await this.forgeRemote(repository)) !== remote
          )
            throw new Error("Forge worktree changed");
        },
      };
    });
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
    const remote = await git(repositoryPath, ["config", "--get", "remote.origin.url"]).catch(
      () => undefined,
    );
    const head =
      remote === undefined
        ? undefined
        : await (
            await this.forgeProviderFor(repositoryPath, repositoryPath, remote.trim())
          )?.resolve?.(number);
    if (!head) throw new ControlError("forge_unavailable");
    if (head.state !== "OPEN") throw new ControlError("pr_not_open");
    if (!head.sameRepository) throw new ControlError("pr_from_fork");
    const branch = head.branch;
    if (!forgeBranch(branch)) throw new ControlError("invalid_branch");
    await this.validateBranch(repositoryPath, branch).catch(() => {
      throw new ControlError("invalid_branch");
    });
    const advertised = await git(repositoryPath, [
      "ls-remote",
      "--symref",
      "--",
      "origin",
      "HEAD",
    ]).catch(() => {
      throw new ControlError("forge_unavailable");
    });
    const defaultBranch = /^ref: refs\/heads\/([^\n\t]+)\tHEAD$/mu.exec(advertised)?.[1];
    if (!defaultBranch) throw new ControlError("forge_unavailable");
    if (branch === defaultBranch) throw new ControlError("default_branch");
    const checkedOut = (await this.listWorktrees(repositoryPath)).filter(
      (tree) => tree.branch === branch,
    );
    if (checkedOut.length > 1) throw new ControlError("branch_in_use");
    const existing = checkedOut[0];
    if (existing) {
      const owned = unused.find((tree) => tree.path === existing.path);
      if (
        !owned ||
        !existing.managed ||
        existing.bare ||
        existing.locked ||
        existing.prunable ||
        (await this.launchIdentity(repositoryPath, existing.path).catch(() => undefined)) !==
          owned.identity
      )
        throw new ControlError("branch_in_use");
      revalidate(existing.path, branch);
      await git(repositoryPath, [
        "fetch",
        "--no-tags",
        "--",
        "origin",
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ]);
      revalidate(existing.path, branch);
      if (
        (await this.launchIdentity(repositoryPath, existing.path).catch(() => undefined)) !==
        owned.identity
      )
        throw new ControlError("branch_in_use");
      await this.fastForwardAdoptedBranch(
        repositoryPath,
        branch,
        async () => {
          revalidate(existing.path, branch);
          const current = (await this.listWorktrees(repositoryPath)).filter(
            (tree) => tree.branch === branch,
          );
          if (current.length !== 1 || current[0]?.path !== existing.path)
            throw new ControlError("branch_in_use");
          if (
            (await this.launchIdentity(repositoryPath, existing.path).catch(() => undefined)) !==
            owned.identity
          )
            throw new ControlError("branch_in_use");
        },
        existing.path,
      );
      await git(repositoryPath, [
        "branch",
        "--set-upstream-to",
        `refs/remotes/origin/${branch}`,
        "--",
        branch,
      ]);
      await git(repositoryPath, ["config", `branch.${branch}.pushRemote`, "origin"]);
      return { path: existing.path, branch, identity: owned.identity };
    }
    revalidate(undefined, branch);
    await git(repositoryPath, [
      "fetch",
      "--no-tags",
      "--",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    revalidate(undefined, branch);
    await this.fastForwardAdoptedBranch(repositoryPath, branch, () => {
      revalidate(undefined, branch);
    });
    try {
      const { path } = await this.createWorktree(repositoryPath, branch, {
        location,
        trackOrigin: true,
      });
      await git(repositoryPath, ["config", `branch.${branch}.pushRemote`, "origin"]);
      return { path, branch, identity: await this.launchIdentity(repositoryPath, path) };
    } catch (error) {
      if (error instanceof ControlError) throw error;
      const trees = await this.listWorktrees(repositoryPath).catch(() => undefined);
      if (!trees || trees.some((tree) => tree.branch === branch)) throw new UncertainEffect();
      throw error;
    }
  }

  /** Advance only by ancestry; Git also guards against concurrent local ref changes. */
  private async fastForwardAdoptedBranch(
    repository: string,
    branch: string,
    revalidate: () => void | Promise<void>,
    checkout?: string,
  ): Promise<void> {
    const localRef = `refs/heads/${branch}`;
    const local = (
      await git(repository, ["branch", "--list", "--format=%(objectname)", "--", branch])
    ).trim();
    if (!local) return;
    const target = (
      await git(repository, ["rev-parse", "--verify", `refs/remotes/origin/${branch}`])
    ).trim();
    if (local === target) return;
    await git(repository, ["merge-base", "--is-ancestor", local, target]).catch(
      (error: unknown) => {
        if (record(error) && error["code"] === 1) throw new ControlError("branch_diverged");
        throw error;
      },
    );
    await revalidate();
    if (checkout) {
      await git(checkout, ["merge", "--ff-only", "--no-edit", target]);
    } else {
      // Unlike branch -f/update-ref, a non-forced fetch refuses both a concurrent
      // divergence and a branch that has become checked out in another worktree.
      await git(repository, [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--",
        ".",
        `${target}:${localRef}`,
      ]);
    }
  }

  /**
   * Creates a checkout for a validated branch: an existing local branch, a branch on
   * the remote tracking it, and otherwise a new branch from HEAD. A branch that is already
   * checked out is reported, not added again.
   */
  async createWorktree(
    repositoryPath: string,
    branch: string,
    options: CreateWorktreeOptions = {},
  ): Promise<CreatedWorktree> {
    const repository = this.repository(repositoryPath);
    await this.validateBranch(repositoryPath, branch);
    const checkedOut = (await this.listWorktrees(repository.path)).find(
      (tree) => tree.branch === branch,
    );
    if (checkedOut) {
      if (options.trackOrigin) throw new ControlError("branch_in_use");
      if (options.newBranch) throw new Error("Branch already exists");
      return { path: checkedOut.path, outcome: "open" };
    }
    const location = options.location ?? "root";
    const configuredRoot = location === "adjacent" ? dirname(repository.path) : this.root;
    await mkdir(configuredRoot, { recursive: true });
    const root = await realpath(configuredRoot);
    const path =
      location === "adjacent"
        ? resolve(root, `${repository.name}-${branch}`)
        : resolve(root, repository.name, branch);
    assertInside(root, path);
    const exists = await git(repository.path, [
      "branch",
      "--list",
      "--format=%(refname)",
      "--",
      branch,
    ]);
    if (exists && options.newBranch) throw new Error("Branch already exists");
    const remote = options.trackOrigin
      ? "origin"
      : exists || options.newBranch
        ? undefined
        : pickRemote(await git(repository.path, ["remote"]));
    const tracked = `refs/remotes/${remote ?? ""}/${branch}`;
    const onRemote =
      remote !== undefined &&
      (await git(repository.path, ["for-each-ref", "--format=%(refname)", "--", tracked]))
        .split("\n")
        .includes(tracked);
    if (options.trackOrigin && !onRemote) throw new Error("PR branch unavailable");
    if (options.trackOrigin && exists)
      await git(repository.path, ["branch", "--set-upstream-to", tracked, "--", branch]);
    await prepareParent(root, path);
    try {
      // The full remote ref avoids ambiguity with a local branch named like `origin/x`.
      await git(repository.path, [
        "worktree",
        "add",
        ...(exists ? [] : onRemote ? ["--track", "-b", branch] : ["-b", branch]),
        "--",
        path,
        ...(exists ? [branch] : onRemote ? [tracked] : []),
      ]);
    } catch (error) {
      // Only remove the empty directory we reserved; never recursively delete on failure.
      await rmdir(path).catch(() => undefined);
      throw error;
    }
    this.managed.set(path, {
      repository: repository.path,
      root,
      identity: await worktreeIdentity(path),
    });
    await this.save();
    return { path, outcome: exists ? "existing" : onRemote ? "origin" : "new" };
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
    const identity = await this.launchIdentity(repository, worktree);
    const key = `${repository}\0${worktree}`;
    const cached = this.panelCache.get(key);
    if (cached?.identity === identity && Date.now() - cached.time < 3000) return cached.result;
    const result = this.readPanelFacts(repository, worktree);
    this.panelCache.set(key, { identity, time: Date.now(), result });
    return result;
  }

  private async readPanelFacts(repository: string, worktree: string): Promise<GitPanelFacts> {
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
    const fetch = this.fetchFacts.get(repository);
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
    if (!tree.branch || !tree.head || this.fetchFacts.get(repository)?.branch === tree.branch)
      return false;
    await this.validateBranch(repository, tree.branch);
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
  ): Promise<void> {
    const repository = this.repository(repositoryPath);
    validatePath(path);
    const resolved = resolve(path);
    const expected = identity ?? (await this.removalIdentity(repositoryPath, resolved));
    await this.checkRemovalIdentity(repositoryPath, resolved, expected);
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
