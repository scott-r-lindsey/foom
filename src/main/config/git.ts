import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Paths Foom owns outside the untrusted repository: empty hooks, template and global config. */
export interface GitIsolation {
  hooks: string;
  template: string;
  global: string;
  index: string;
}

const IDENTITY = { name: "Foom", email: "foom@localhost" };

/**
 * Options that keep repository-configured programs from running. The repository is
 * agent-writable, so `.git/config` may name hooks, fsmonitor, pagers, editors, signing
 * programs, filters, diff or merge drivers. Foom only uses plumbing that never reads
 * filters or drivers, and overrides the rest here.
 */
export function hardenedArguments(root: string, isolation: GitIsolation): string[] {
  return [
    "--no-pager",
    "--git-dir",
    join(root, ".git"),
    "--work-tree",
    root,
    "-c",
    `core.hooksPath=${isolation.hooks}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.pager=cat",
    "-c",
    "core.editor=:",
    "-c",
    "sequence.editor=:",
    "-c",
    "core.askPass=",
    "-c",
    "credential.helper=",
    "-c",
    "core.attributesFile=",
    "-c",
    "diff.external=",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "tag.gpgSign=false",
    "-c",
    "log.showSignature=false",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "-c",
    "protocol.allow=never",
  ];
}

/** No inherited `GIT_*` variables, no system config, and an empty Foom-owned global config. */
export function hardenedEnvironment(
  source: NodeJS.ProcessEnv,
  isolation: GitIsolation,
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
    ),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: isolation.global,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: ":",
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
  };
}

/** Creates the empty hooks and template folders and the empty global config, every launch. */
export async function prepareIsolation(directory: string): Promise<GitIsolation> {
  const isolation = {
    hooks: join(directory, "hooks"),
    template: join(directory, "template"),
    global: join(directory, "global.gitconfig"),
    index: join(directory, "index"),
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const folder of [isolation.hooks, isolation.template]) {
    const entries = await readdir(folder).catch(() => null);
    const info = await lstat(folder).catch(() => null);
    if (!entries || entries.length > 0 || !info?.isDirectory()) {
      await rm(folder, { recursive: true, force: true });
      await mkdir(folder, { mode: 0o700 });
    }
  }
  await writeFile(isolation.global, "", { mode: 0o600 });
  return isolation;
}

export type GitRunner = (
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; input?: Uint8Array },
) => Promise<Buffer>;

const runGit: GitRunner = (args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...args],
      {
        env: options.env,
        encoding: "buffer",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(new Error("Git command failed"));
        else resolve(stdout);
      },
    );
    // Git may exit before reading stdin; the command's own result reports any failure.
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input);
  });

export interface TreeEntry {
  mode: string;
  type: string;
  object: string;
}

export interface CommitRecord {
  commit: string;
  time: number;
  subject: string;
  files: string[];
}

/** One changed path in a commit: object IDs before and after, null when absent. */
export interface CommitChange {
  path: string;
  before: string | null;
  after: string | null;
}

const ZERO = /^0+$/;

/** Hardened git access to the agent-writable config repository. */
export class ConfigGit {
  private format: "sha1" | "sha256" | undefined;

  constructor(
    readonly root: string,
    private readonly isolation: GitIsolation,
    private readonly run: GitRunner = runGit,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private git(
    args: readonly string[],
    input?: Uint8Array,
    extra: NodeJS.ProcessEnv = {},
  ): Promise<Buffer> {
    return this.run([...hardenedArguments(this.root, this.isolation), ...args], {
      env: { ...hardenedEnvironment(this.env, this.isolation), ...extra },
      ...(input ? { input } : {}),
    });
  }

  private async text(args: readonly string[], extra?: NodeJS.ProcessEnv): Promise<string> {
    return (await this.git(args, undefined, extra)).toString("utf8").trim();
  }

  /** Only `.git` in the folder itself counts; a parent repository never does. */
  async exists(): Promise<boolean> {
    return (await lstat(join(this.root, ".git")).catch(() => null)) !== null;
  }

  async init(): Promise<void> {
    await this.git([
      "-c",
      "init.defaultBranch=main",
      "init",
      "--quiet",
      `--template=${this.isolation.template}`,
    ]);
  }

  async head(): Promise<string | null> {
    try {
      const commit = await this.text(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
      return commit || null;
    } catch {
      return null;
    }
  }

  /** Blob ID for exact bytes, computed without git so no filter can see the content. */
  async objectId(bytes: Uint8Array): Promise<string> {
    this.format ??=
      (await this.text(["rev-parse", "--show-object-format"]).catch(() => "sha1")) === "sha256"
        ? "sha256"
        : "sha1";
    return createHash(this.format)
      .update(`blob ${String(bytes.length)}\0`)
      .update(bytes)
      .digest("hex");
  }

  async tree(commit: string): Promise<Map<string, TreeEntry>> {
    const output = (await this.git(["ls-tree", "-r", "-z", "--full-tree", commit])).toString(
      "utf8",
    );
    const entries = new Map<string, TreeEntry>();
    for (const record of output.split("\0")) {
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      const [mode, type, object] = record.slice(0, tab).split(" ");
      if (mode && type && object) entries.set(record.slice(tab + 1), { mode, type, object });
    }
    return entries;
  }

  /** Raw blob bytes. `cat-file blob` never applies filters or text conversion. */
  async blob(object: string): Promise<Buffer> {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(object)) throw new Error("Invalid object");
    return this.git(["cat-file", "blob", object]);
  }

  /**
   * Commits exactly the given paths on top of HEAD through a private index, then
   * mirrors them into the real index. No hooks, filters or signing programs run.
   */
  async commit(changes: ReadonlyMap<string, Uint8Array | null>, message: string): Promise<string> {
    const head = await this.head();
    const index = { GIT_INDEX_FILE: this.isolation.index };
    await rm(this.isolation.index, { force: true });
    try {
      if (head) await this.git(["read-tree", head], undefined, index);
      const entries: { path: string; object: string | null }[] = [];
      for (const [path, bytes] of changes) {
        if (bytes === null) {
          await this.git(["update-index", "--force-remove", "--", path], undefined, index);
          entries.push({ path, object: null });
          continue;
        }
        const object = (await this.git(["hash-object", "-w", "--no-filters", "--stdin"], bytes))
          .toString("utf8")
          .trim();
        await this.git(
          ["update-index", "--add", "--cacheinfo", `100644,${object},${path}`],
          undefined,
          index,
        );
        entries.push({ path, object });
      }
      const tree = await this.text(["write-tree"], index);
      const commit = (
        await this.git(
          ["commit-tree", tree, ...(head ? ["-p", head] : []), "-F", "-"],
          Buffer.from(message),
        )
      )
        .toString("utf8")
        .trim();
      await this.git(["update-ref", "-m", "foom: commit", "HEAD", commit, head ?? ""]);
      // Best effort: keep `git status` in the folder consistent without touching other paths.
      for (const entry of entries)
        await this.git(
          entry.object === null
            ? ["update-index", "--force-remove", "--", entry.path]
            : ["update-index", "--add", "--cacheinfo", `100644,${entry.object},${entry.path}`],
        ).catch(() => undefined);
      return commit;
    } finally {
      await rm(this.isolation.index, { force: true });
    }
  }

  /** Recent commits with their changed paths; log never runs drivers without a patch. */
  async log(limit: number): Promise<CommitRecord[]> {
    const output = (
      await this.git([
        "log",
        `-n${String(limit)}`,
        "--no-renames",
        "--no-textconv",
        "--no-ext-diff",
        "--name-only",
        "-z",
        "--format=%x1e%H%x1f%ct%x1f%s",
        "HEAD",
        "--",
      ])
    ).toString("utf8");
    return output
      .split("\x1e")
      .slice(1)
      .flatMap((record) => {
        const [header = "", ...rest] = record.split("\0");
        const [commit, time, subject] = header.split("\x1f");
        const names = [header.split("\n").slice(1).join("\n"), ...rest]
          .map((name) => name.replace(/^\n/, ""))
          .filter(Boolean);
        if (!commit || !time || subject === undefined) return [];
        return [
          {
            commit,
            time: Number(time) * 1000,
            subject: subject.split("\n")[0] ?? "",
            files: names,
          },
        ];
      });
  }

  /** Paths a commit changed, compared with its first parent (or the empty tree). */
  async changes(commit: string): Promise<CommitChange[]> {
    const output = (
      await this.git([
        "diff-tree",
        "-r",
        "-z",
        "--root",
        "--no-renames",
        "--no-textconv",
        "--no-ext-diff",
        "--no-commit-id",
        commit,
      ])
    ).toString("utf8");
    const parts = output.split("\0").filter(Boolean);
    const result: CommitChange[] = [];
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const [, , before, after] = (parts[index] ?? "").split(" ");
      const path = parts[index + 1];
      if (!path || !before || !after) continue;
      result.push({
        path,
        before: ZERO.test(before) ? null : before,
        after: ZERO.test(after) ? null : after,
      });
    }
    return result;
  }
}
