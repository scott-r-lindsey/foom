import { inventoryWatchPaths } from "./inventory-watch";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { CreateWorktreeOptions, Repository, Worktree } from "../../shared/worktrees";

const execute = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  // Ignore inherited repository selectors: the validated cwd selects the repository.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const { stdout } = await execute("git", args, {
    cwd,
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 30_000,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function validatePath(path: string): void {
  if (!path || path.includes("\0")) throw new Error("Invalid path");
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

// Bind ownership to both the filesystem entries and Git's per-worktree metadata.
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

/** Main-process service. Use open() for persisted ownership; listing never adopts trees. */
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
  static async open(userData: string, root?: string): Promise<WorktreeService> {
    validatePath(userData);
    const service = new WorktreeService(root);
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

  constructor(root = join(homedir(), ".foom", "worktrees")) {
    validatePath(root);
    this.root = resolve(root);
  }

  async addRepository(path: string): Promise<Repository> {
    validatePath(path);
    const cwd = await realpath(resolve(path));
    if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true") {
      throw new Error("Repository must be a Git work tree");
    }
    const top = await realpath((await git(cwd, ["rev-parse", "--show-toplevel"])).slice(0, -1));
    const repository = Object.freeze({ path: top, name: basename(top) });
    this.repositories.set(top, repository);
    await this.save();
    return repository;
  }

  /**
   * Forgets a repository. Refused while Foom still owns worktrees in it, so their
   * ownership records aren't silently dropped; remove those worktrees first.
   */
  async removeRepository(path: string): Promise<void> {
    this.repository(path);
    const owned = [...this.managed.values()].filter((entry) => entry.repository === path).length;
    if (owned > 0)
      throw new Error(
        `Has ${String(owned)} ${owned === 1 ? "worktree" : "worktrees"} Foom made; remove ${owned === 1 ? "it" : "them"} first`,
      );
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

  /** Validate a selected checkout without adopting it as Foom-owned. */
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
    if (identity !== undefined) {
      await this.checkRemovalIdentity(repositoryPath, path, identity);
      return git(path, [
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
    }
    const trees = await this.listWorktrees(repositoryPath);
    if (!trees.some((tree) => tree.path === path && tree.managed && !tree.prunable && !tree.locked))
      throw new Error("Worktree is not managed by Foom or is locked");
    return git(path, [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
  }

  async createWorktree(
    repositoryPath: string,
    branch: string,
    options: CreateWorktreeOptions = {},
  ): Promise<string> {
    const repository = this.repository(repositoryPath);
    await this.validateBranch(repositoryPath, branch);
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
    await prepareParent(root, path);
    try {
      // Git creates a new branch when absent and checks out an existing branch otherwise.
      await git(repository.path, [
        "worktree",
        "add",
        ...(exists ? [] : ["-b", branch]),
        "--",
        path,
        ...(exists ? [branch] : []),
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
    return path;
  }

  private readonly mergeDefaults = new Map<string, { time: number; result: Promise<string> }>();

  /** Inventory shares a recent fetch; destructive actions always fetch again. */
  async mergedDefault(repository: string, refresh = false): Promise<string> {
    this.repository(repository);
    const cached = this.mergeDefaults.get(repository);
    if (!refresh && cached && Date.now() - cached.time < 60_000) return cached.result;
    const result = this.fetchDefault(repository);
    this.mergeDefaults.set(repository, { time: Date.now(), result });
    return result;
  }

  private async fetchDefault(repository: string): Promise<string> {
    const remotes = (await git(repository, ["remote"])).trim().split("\n").filter(Boolean);
    const remote = remotes.includes("origin")
      ? "origin"
      : remotes.length === 1
        ? remotes[0]
        : undefined;
    if (!remote || remote.startsWith("-")) throw new Error("No unambiguous repository remote");
    try {
      await git(repository, ["fetch", "--prune", "--", remote]);
      const advertised = await git(repository, ["ls-remote", "--symref", "--", remote, "HEAD"]);
      const ref = /^ref: (refs\/heads\/[^\n\t]+)\tHEAD$/mu.exec(advertised)?.[1];
      const head = /^([a-f0-9]{40,64})\tHEAD$/mu.exec(advertised)?.[1];
      if (!ref || !head) throw new Error("Remote default branch is unavailable");
      await this.validateBranch(repository, ref.slice("refs/heads/".length));
      // Fetch explicitly as well: a custom fetch refspec may omit the default branch.
      await git(repository, ["fetch", "--no-write-fetch-head", "--", remote, ref]);
      return (await git(repository, ["rev-parse", "--verify", `${head}^{commit}`])).trim();
    } catch (error) {
      throw new Error(
        `Cannot check merged worktrees: fetch failed. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async mergedCommit(repository: string, tree: Worktree, base: string): Promise<boolean> {
    if (!tree.branch || !tree.head) return false;
    await this.validateBranch(repository, tree.branch);
    if (!/^[a-f0-9]{40,64}$/u.test(base) || !/^[a-f0-9]{40,64}$/u.test(tree.head))
      throw new Error("Invalid commit ID");
    const defaultTree = (await git(repository, ["rev-parse", `${base}^{tree}`])).trim();
    try {
      return (
        (await git(repository, ["merge-tree", "--write-tree", base, tree.head])).trim() ===
        defaultTree
      );
    } catch {
      // Conflicts, unrelated histories and unsupported Git versions never authorize deletion.
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

  async removeWorktree(
    repositoryPath: string,
    path: string,
    force = false,
    identity?: string,
  ): Promise<void> {
    const repository = this.repository(repositoryPath);
    validatePath(path);
    const resolved = resolve(path);
    if (identity !== undefined) {
      await this.checkRemovalIdentity(repositoryPath, resolved, identity);
    } else {
      const ownership = this.managed.get(resolved);
      if (ownership?.repository !== repository.path)
        throw new Error("Worktree is not managed by Foom");
      assertInside(ownership.root, resolved);
      if ((await realpath(resolved)) !== resolved)
        throw new Error("Worktree path has been redirected");
      if (!(await this.isManaged(repository.path, resolved)))
        throw new Error("Worktree is not managed by Foom");
    }
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
