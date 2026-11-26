import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { ControlError } from "../../shared/control-validation";
import type { CreatedWorktree, CreateWorktreeOptions } from "../../shared/worktrees";
import { forgeBranch } from "../control/forge";
import type { ForgeProviderFactory } from "../control/forge.d";
import { UncertainEffect } from "./worktree-outcome";
import type {
  AdoptionService,
  CreationContext,
  ForgeProviderFor,
  ForgeService,
} from "./worktree-features.d";
import { worktreeIdentity } from "./worktree-identity";
export { worktreeIdentity } from "./worktree-identity";

const execute = promisify(execFile);

export async function git(
  cwd: string,
  args: string[],
  timeout = 30_000,
  input?: string,
  isolated = false,
  encoding: "utf8" | "latin1" = "utf8",
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
    encoding,
    maxBuffer: 16 * 1024 * 1024,
  });
  operation.child.stdin?.end(input);
  const { stdout } = await operation;
  return stdout;
}

/** NUL-delimited porcelain v1 represented as Latin-1, one code unit per Git byte. */
export function removalStatus(raw: string) {
  const records = raw.split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    paths.add(record.slice(3));
    // For renames and copies, porcelain -z places the destination first.
    if (/[RC]/u.test(record.slice(0, 2))) index++;
  }
  return { changes: Buffer.from(raw, "latin1").toString("utf8"), fileCount: paths.size };
}

// Remote management already exchanges Git's newline-delimited, C-quoted
// porcelain. Undo quoting before counting so escaped and literal bytes agree.
const quotedGitPath = String.raw`("(?:[^"\\]|\\(?:[0-7]{3}|[abfnrtv"\\]))*"|[^"]+?)`;
const gitPathRecord = new RegExp(`^${quotedGitPath}$`, "u");
const gitMoveRecord = new RegExp(`^${quotedGitPath} -> ${quotedGitPath}$`, "u");
const gitEscapes = new Map([
  ["a", "\x07"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ['"', '"'],
  ["\\", "\\"],
]);

function gitPathBytes(path: string): string {
  if (!path.startsWith('"')) return Buffer.from(path).toString("latin1");
  return Buffer.from(path.slice(1, -1))
    .toString("latin1")
    .replace(
      /\\([0-7]{3}|[abfnrtv"\\])/gu,
      (_match, escape: string) =>
        gitEscapes.get(escape) ?? String.fromCharCode(Number.parseInt(escape, 8)),
    );
}

export function remoteRemovalStatus(status: string, displayPath: (path: string) => string) {
  const files = new Set<string>();
  const display: string[] = [];
  for (const line of status.split("\n")) {
    if (!line) continue;
    const flags = line.slice(0, 2);
    const moved = /[RC]/u.test(flags);
    const match = (moved ? gitMoveRecord : gitPathRecord).exec(line.slice(3));
    const target = match?.[moved ? 2 : 1];
    if (!target || (moved && !match[1])) throw new Error("Invalid remote worktree status");
    const raw = gitPathBytes(target);
    files.add(raw);
    display.push(`${flags} ${displayPath(Buffer.from(raw, "latin1").toString("utf8"))}`);
    const source = moved ? match[1] : undefined;
    if (source)
      display.push(displayPath(Buffer.from(gitPathBytes(source), "latin1").toString("utf8")));
  }
  return { changes: display.length ? `${display.join("\0")}\0` : "", fileCount: files.size };
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
/** Canonical, non-symlink directory identity for empty-parent pruning only. */
export async function parentIdentity(path: string): Promise<string> {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error("Worktree parent has been redirected");
  return [entry.dev, entry.ino, entry.birthtimeNs].map(String).join(":");
}

export async function prepareParent(root: string, path: string): Promise<string[]> {
  assertInside(root, path);
  const created: string[] = [];
  let current = root;
  for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current);
      created.push(current);
    } catch (error) {
      if (!record(error) || error["code"] !== "EEXIST") throw error;
    }
    const canonical = await realpath(current);
    assertInside(root, canonical);
    if (canonical !== current) throw new Error("Worktree parent has been redirected");
  }
  // Reject an existing destination, including empty directories and symlinks.
  await mkdir(path);
  return created;
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
  review = false,
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
  if (review) {
    revalidate(undefined);
    // A private fetch ref avoids FETCH_HEAD races with inventory/background fetches.
    const ref = `refs/foom-review-fetch/${randomUUID()}`;
    let attemptedCreation = false;
    try {
      await git(repositoryPath, [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--",
        "origin",
        `+refs/heads/${branch}:${ref}`,
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ]);
      const head = (await git(repositoryPath, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head)) throw new Error("Invalid PR head");
      revalidate(undefined);
      try {
        attemptedCreation = true;
        const { path } = await service.createWorktree(
          repositoryPath,
          `review-${String(number)}-${randomUUID()}`,
          { location, detachedHead: head, reviewBranch: branch },
        );
        return { path, branch, identity: await service.launchIdentity(repositoryPath, path) };
      } catch {
        // Creation/persistence may have succeeded before a later validation failed.
        throw new UncertainEffect();
      }
    } finally {
      await git(repositoryPath, ["update-ref", "-d", ref]).catch((error: unknown) => {
        if (attemptedCreation) throw new UncertainEffect();
        throw error;
      });
    }
  }
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
    const readIdentity = () => service.launchIdentity(repository, path, { skipOwnership: true });
    const readBranch = async () =>
      (await service.listWorktrees(repository, { skipOwnership: true })).find(
        (row) => row.path === path,
      )?.branch;
    const identity = await readIdentity();
    const branch = await readBranch();
    return {
      identity: JSON.stringify([repository, path, identity, branch, remote]),
      validate: async () => {
        repositoryExists(repository);
        if (
          (await readIdentity()) !== identity ||
          (await readBranch()) !== branch ||
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
  if (checkedOut && options.detachedHead === undefined) {
    if (options.trackOrigin) throw new ControlError("branch_in_use");
    if (options.newBranch) throw new Error("Branch already exists");
    return { path: checkedOut.path, outcome: "open" };
  }
  if (
    options.detachedHead !== undefined &&
    (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(options.detachedHead) ||
      options.newBranch ||
      options.trackOrigin)
  )
    throw new Error("Invalid detached creation");
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
  const created = await prepareParent(root, path);
  // The repository namespace is retained; only slash-branch parents are candidates.
  if (location === "root") {
    const namespace = resolve(root, repository.name);
    for (const parent of created) {
      if (parent !== namespace && within(namespace, parent))
        context.createdParents.set(parent, await parentIdentity(parent));
    }
  }
  try {
    // The full remote ref avoids ambiguity with a local branch named like `origin/x`.
    await git(repository.path, [
      ...(options.detachedHead ? ["-c", "core.logAllRefUpdates=true"] : []),
      "worktree",
      "add",
      ...(options.detachedHead
        ? ["--detach"]
        : exists
          ? []
          : onRemote
            ? ["--track", "-b", branch]
            : ["-b", branch]),
      "--",
      path,
      ...(options.detachedHead
        ? [options.detachedHead]
        : exists
          ? [branch]
          : onRemote
            ? [tracked]
            : []),
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
    directoryIdentity: await parentIdentity(path),
  });
  await context.save();
  return { path, outcome: exists ? "existing" : onRemote ? "origin" : "new" };
}
