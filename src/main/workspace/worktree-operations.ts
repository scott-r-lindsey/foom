import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, stat as fileStat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { ControlError } from "../../node-common/control-validation";
import type { GitPanelFacts } from "../../shared/panel";
import type { CreatedWorktree, CreateWorktreeOptions } from "../../shared/worktrees";
import { forgeBranch } from "../control/forge";
import type { ForgeProviderFactory } from "../control/forge.d";
import { UncertainEffect } from "./worktree-outcome";
import type {
  AdoptionService,
  CreationContext,
  FetchFacts,
  ForgeProviderFor,
  ForgeService,
} from "./worktree-features.d";

const execute = promisify(execFile);

export async function git(
  cwd: string,
  args: string[],
  timeout = 30_000,
  input?: string,
  isolated = false,
): Promise<string> {
  // Ignore inherited repository selectors: the validated cwd selects the repository.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  const operation = execute("git", args, {
    cwd,
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: "0",
      // Workspace decisions must use stored history, never local history overlays.
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_GRAFT_FILE: "/dev/null",
      ...(isolated
        ? {
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_ATTR_NOSYSTEM: "1",
          }
        : {}),
    },
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  operation.child.stdin?.end(input);
  const { stdout } = await operation;
  return stdout;
}

export function validatePath(path: string): void {
  if (!path || path.includes("\0")) throw new Error("Invalid path");
}

/** Whether `path` is `root` or inside it. */
export function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function assertInside(root: string, path: string): void {
  const child = relative(root, path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Worktree path must stay inside its allowed root");
  }
}

// Walk one component at a time so an existing symlink cannot redirect mkdir
// outside the allowed root, even when the remaining parent directories are new.
export async function prepareParent(root: string, path: string): Promise<void> {
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

/** Read only the checkout's own Git marker, never search ancestors or trust a cache.
 * Membership and common-directory authorization still use Git in checkoutIdentity. */
async function checkoutGitDirectory(path: string): Promise<string> {
  const marker = join(path, ".git");
  const markerMetadata = await fileStat(marker);
  if (markerMetadata.isDirectory()) return realpath(marker);
  if (!markerMetadata.isFile() || markerMetadata.size > 64 * 1024) {
    throw new Error("Invalid Git marker");
  }
  // Refuse special files before opening; recheck the descriptor in case the marker changed.
  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;
  const handle = await open(marker, flags);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 64 * 1024) throw new Error("Invalid Git marker");
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 64 * 1024) throw new Error("Invalid Git marker");
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    if (!text.startsWith("gitdir: ") || text.includes("\0")) throw new Error("Invalid Git marker");
    const directory = text.slice(8).replace(/[\r\n]+$/u, "");
    if (!directory) throw new Error("Invalid Git marker");
    return await realpath(resolve(path, directory));
  } finally {
    await handle.close();
  }
}

// Bind confirmation to both the filesystem entries and Git's per-worktree metadata.
// Birth time distinguishes recreated entries even when the filesystem reuses an inode.
export async function worktreeIdentity(path: string): Promise<string> {
  const gitDirectory = await checkoutGitDirectory(path);
  const entries = await Promise.all(
    [path, join(path, ".git"), gitDirectory].map(async (entry) => {
      const stat = await lstat(entry, { bigint: true });
      return [stat.dev, stat.ino, stat.birthtimeNs].map(String);
    }),
  );
  return JSON.stringify([gitDirectory, entries]);
}

/** The repository's remote: origin, or its only remote. */
export function pickRemote(output: string): string | undefined {
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
export function refNames(output: string, prefix: string): string[] {
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

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function absolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    resolve(value) === value
  );
}

/** Only main-owned unused checkouts can be reused; no caller supplies a remote or path. */
export async function adoptWorktree(
  service: AdoptionService,
  forgeProviderFor: ForgeProviderFor,
  repositoryPath: string,
  number: number,
  unused: readonly { path: string; identity: string }[],
  revalidate: (path?: string, branch?: string) => void,
  location: "root" | "adjacent" = "root",
): Promise<{ path: string; branch: string; identity: string }> {
  const remote = await git(repositoryPath, ["config", "--get", "remote.origin.url"]).catch(
    () => undefined,
  );
  const head =
    remote === undefined
      ? undefined
      : await (await forgeProviderFor(repositoryPath, repositoryPath, remote.trim()))?.resolve?.(
          number,
        );
  if (!head) throw new ControlError("forge_unavailable");
  if (head.state !== "OPEN") throw new ControlError("pr_not_open");
  if (!head.sameRepository) throw new ControlError("pr_from_fork");
  const branch = head.branch;
  if (!forgeBranch(branch)) throw new ControlError("invalid_branch");
  await service.validateBranch(repositoryPath, branch).catch(() => {
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
  const checkedOut = (await service.listWorktrees(repositoryPath)).filter(
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
      (await service.launchIdentity(repositoryPath, existing.path).catch(() => undefined)) !==
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
      (await service.launchIdentity(repositoryPath, existing.path).catch(() => undefined)) !==
      owned.identity
    )
      throw new ControlError("branch_in_use");
    await fastForwardAdoptedBranch(
      repositoryPath,
      branch,
      async () => {
        revalidate(existing.path, branch);
        const current = (await service.listWorktrees(repositoryPath)).filter(
          (tree) => tree.branch === branch,
        );
        if (current.length !== 1 || current[0]?.path !== existing.path)
          throw new ControlError("branch_in_use");
        if (
          (await service.launchIdentity(repositoryPath, existing.path).catch(() => undefined)) !==
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
  await fastForwardAdoptedBranch(repositoryPath, branch, () => {
    revalidate(undefined, branch);
  });
  try {
    const { path } = await service.createWorktree(repositoryPath, branch, {
      location,
      trackOrigin: true,
    });
    await git(repositoryPath, ["config", `branch.${branch}.pushRemote`, "origin"]);
    return { path, branch, identity: await service.launchIdentity(repositoryPath, path) };
  } catch (error) {
    if (error instanceof ControlError) throw error;
    const trees = await service.listWorktrees(repositoryPath).catch(() => undefined);
    if (!trees || trees.some((tree) => tree.branch === branch)) throw new UncertainEffect();
    throw error;
  }
}

/** Advance only by ancestry; Git also guards against concurrent local ref changes. */
async function fastForwardAdoptedBranch(
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
  await git(repository, ["merge-base", "--is-ancestor", local, target]).catch((error: unknown) => {
    if (record(error) && error["code"] === 1) throw new ControlError("branch_diverged");
    throw error;
  });
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

export async function forgeProviderFor(
  service: ForgeService,
  provider: ForgeProviderFactory,
  repositoryExists: (path: string) => unknown,
  repository: string,
  path: string,
  remote: string,
) {
  return provider(remote, async () => {
    const identity = await service.launchIdentity(repository, path);
    const branch = (await service.listWorktrees(repository)).find(
      (row) => row.path === path,
    )?.branch;
    return {
      identity: JSON.stringify([repository, path, identity, branch, remote]),
      validate: async () => {
        repositoryExists(repository);
        if (
          (await service.launchIdentity(repository, path)) !== identity ||
          (await service.listWorktrees(repository)).find((row) => row.path === path)?.branch !==
            branch ||
          (await service.forgeRemote(repository)) !== remote
        )
          throw new Error("Forge worktree changed");
      },
    };
  });
}

/**
 * Creates a checkout for a validated branch: an existing local branch, a branch on
 * the remote tracking it, and otherwise a new branch from HEAD. A branch that is already
 * checked out is reported, not added again.
 */
export async function createWorktree(
  context: CreationContext,
  repositoryPath: string,
  branch: string,
  options: CreateWorktreeOptions = {},
): Promise<CreatedWorktree> {
  const repository = context.repository(repositoryPath);
  await context.validateBranch(repositoryPath, branch);
  const checkedOut = (await context.listWorktrees(repository.path)).find(
    (tree) => tree.branch === branch,
  );
  if (checkedOut) {
    if (options.trackOrigin) throw new ControlError("branch_in_use");
    if (options.newBranch) throw new Error("Branch already exists");
    return { path: checkedOut.path, outcome: "open" };
  }
  const location = options.location ?? "root";
  const configuredRoot = location === "adjacent" ? dirname(repository.path) : context.root;
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
  context.managed.set(path, {
    repository: repository.path,
    root,
    identity: await worktreeIdentity(path),
  });
  await context.save();
  return { path, outcome: exists ? "existing" : onRemote ? "origin" : "new" };
}

export async function readPanelFacts(
  fetchFacts: ReadonlyMap<string, FetchFacts>,
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
  const fetch = fetchFacts.get(repository);
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
