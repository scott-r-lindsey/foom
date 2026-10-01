import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { ScanProgress } from "../../shared/setup";

export const RECENT_DAYS = 30;
const DAY = 86_400_000;

/**
 * Heavy system folders that never hold the user's repositories. Names like `build` or
 * `dist` aren't listed: a repository may be called that, and inside a repository
 * the scan never looks anyway.
 */
const SKIPPED = new Set(["node_modules", "Library", "AppData", "Applications"]);

export interface ScannedRepository {
  path: string;
  name: string;
  relative: string;
  branch: string | null;
  lastActive: number | null;
}

export interface ScanOptions {
  /** Levels below the folder to look in; a repository's own contents aren't searched. */
  maxDepth?: number;
  /** Stop after looking at this many folders and report the scan as truncated. */
  maxFolders?: number;
  /** Folders to leave out entirely, such as Foom's own worktree folder. */
  exclude?: readonly string[];
  onProgress?: (progress: ScanProgress) => void;
}

/** The branch HEAD points at, read from the file; null when detached or unreadable. */
async function branchOf(gitDirectory: string): Promise<string | null> {
  try {
    const head = (await readFile(join(gitDirectory, "HEAD"), "utf8")).trim();
    const match = /^ref: refs\/heads\/(.{1,255})$/.exec(head);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Latest git activity, without running git: the newest of the reflog (commits,
 * checkouts, pulls), the index (staging and status refreshes) and HEAD.
 */
async function lastActive(gitDirectory: string): Promise<number | null> {
  const times = await Promise.all(
    [join("logs", "HEAD"), "index", "HEAD"].map((file) =>
      stat(join(gitDirectory, file)).then(
        (entry) => entry.mtimeMs,
        () => undefined,
      ),
    ),
  );
  const known = times.filter((time) => time !== undefined);
  return known.length ? Math.round(Math.max(...known)) : null;
}

export function isRecent(time: number | null, now: number): boolean {
  return time !== null && now - time <= RECENT_DAYS * DAY;
}

/**
 * Finds Git repositories under a folder, breadth first. It stops descending at a
 * repository, never follows symbolic links, skips hidden and heavy folders, and skips
 * linked worktrees and submodules (whose `.git` is a file).
 */
export async function scanCodeFolder(
  folder: string,
  options: ScanOptions = {},
): Promise<{
  folder: string;
  repositories: ScannedRepository[];
  folders: number;
  truncated: boolean;
}> {
  if (!isAbsolute(folder) || folder.includes("\0")) throw new Error("Invalid folder");
  const root = await realpath(folder);
  if (!(await stat(root)).isDirectory()) throw new Error("Not a folder");
  const maxDepth = options.maxDepth ?? 3;
  const maxFolders = options.maxFolders ?? 20_000;
  const exclude = (options.exclude ?? []).map((path) => path + sep);
  const repositories: ScannedRepository[] = [];
  let folders = 0;
  let truncated = false;
  let reported = 0;
  const report = (force = false) => {
    if (!options.onProgress || (!force && folders - reported < 50)) return;
    reported = folders;
    options.onProgress({ folders, repositories: repositories.length });
  };
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length && !truncated; depth++) {
    const next: string[] = [];
    for (const directory of level) {
      if (folders >= maxFolders) {
        truncated = true;
        break;
      }
      folders++;
      report();
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue; // Unreadable folders are skipped.
      }
      const git = entries.find((entry) => entry.name === ".git");
      if (git?.isDirectory()) {
        const gitDirectory = join(directory, ".git");
        repositories.push({
          path: directory,
          name: basename(directory),
          relative: relative(root, directory) || basename(directory),
          branch: await branchOf(gitDirectory),
          lastActive: await lastActive(gitDirectory),
        });
        continue;
      }
      // A `.git` file marks a linked worktree or a submodule, not a repository to add.
      if (git) continue;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
        const child = join(directory, entry.name);
        if (!exclude.some((path) => (child + sep).startsWith(path))) next.push(child);
      }
    }
    level = next;
  }
  report(true);
  repositories.sort((a, b) => a.relative.localeCompare(b.relative));
  return { folder: root, repositories, folders, truncated };
}

/** Common code folders that exist under the home folder. */
export async function suggestCodeFolders(home: string, platform = process.platform) {
  const names = ["code", "src", "projects", "dev", "git", "repos", "workspace", "work"];
  if (platform === "darwin") names.push("Developer");
  const found: string[] = [];
  for (const name of names) {
    const path = join(home, name);
    try {
      if ((await stat(path)).isDirectory()) found.push(path);
    } catch {
      // Not there.
    }
  }
  return found;
}
