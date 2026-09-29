import { execFile } from "node:child_process";
import { mkdir, realpath, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { CreateWorktreeOptions, Repository, Worktree } from "./shared/worktrees";

const execute = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  // Ignore inherited repository selectors: the validated cwd selects the repository.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const { stdout } = await execute("git", args, {
    cwd,
    env,
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

/** Main-process service. Ownership lasts for this service instance; listing never adopts trees. */
export class WorktreeService {
  private readonly repositories = new Map<string, Repository>();
  private readonly managed = new Map<string, { repository: string; root: string }>();
  private readonly root: string;

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
    return repository;
  }

  listRepositories(): readonly Repository[] {
    return [...this.repositories.values()];
  }

  private repository(path: string): Repository {
    const repository = this.repositories.get(path);
    if (!repository) throw new Error("Repository has not been added");
    return repository;
  }

  async listWorktrees(repositoryPath: string): Promise<readonly Worktree[]> {
    const repository = this.repository(repositoryPath);
    const output = await git(repository.path, ["worktree", "list", "--porcelain", "-z"]);
    return output
      .split("\0\0")
      .filter(Boolean)
      .map((record) => {
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
          managed: this.managed.get(resolve(path))?.repository === repository.path,
        };
      });
  }

  async createWorktree(
    repositoryPath: string,
    branch: string,
    options: CreateWorktreeOptions = {},
  ): Promise<string> {
    const repository = this.repository(repositoryPath);
    // Backslashes, drive separators and NUL are unsafe across supported filesystems.
    if (!branch || branch.startsWith("-") || /[\\:\0]/u.test(branch)) {
      throw new Error("Invalid branch name");
    }
    const checked = await git(repository.path, ["check-ref-format", "--branch", branch]);
    if (checked.trimEnd() !== branch) throw new Error("Branch shorthand is not allowed");
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
    this.managed.set(path, { repository: repository.path, root });
    return path;
  }

  async removeWorktree(repositoryPath: string, path: string, force = false): Promise<void> {
    const repository = this.repository(repositoryPath);
    validatePath(path);
    const resolved = resolve(path);
    const ownership = this.managed.get(resolved);
    if (ownership?.repository !== repository.path)
      throw new Error("Worktree is not managed by Foom");
    assertInside(ownership.root, resolved);
    if ((await realpath(resolved)) !== resolved)
      throw new Error("Worktree path has been redirected");
    // Git performs its own dirty/locked checks before removing the tree.
    await git(repository.path, [
      "worktree",
      "remove",
      ...(force ? ["--force"] : []),
      "--",
      resolved,
    ]);
    this.managed.delete(resolved);
  }
}
