import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { isRecent, scanCodeFolder, suggestCodeFolders } from "../../../../src/main/setup/code-scan";
import type { ScanProgress } from "../../../../src/shared/setup";

const executeFile = promisify(execFile);
/**
 * Git inside a hook (such as pre-commit) inherits GIT_DIR, GIT_INDEX_FILE and friends,
 * which would point these commands at the repository being committed. Drop them.
 */
function run(command: string, args: string[], options: { cwd: string }) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return executeFile(command, args, { ...options, env });
}
let root: string;

/** A repository as the scanner sees it: a `.git` folder with HEAD and a reflog. */
async function repository(path: string, head = "ref: refs/heads/main", when?: Date) {
  await mkdir(join(path, ".git", "logs"), { recursive: true });
  await writeFile(join(path, ".git", "HEAD"), `${head}\n`);
  await writeFile(join(path, ".git", "logs", "HEAD"), "");
  if (when)
    for (const file of ["HEAD", join("logs", "HEAD")])
      await utimes(join(path, ".git", file), when, when);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "foom-code-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("finds repositories, their branches and last activity, and skips what isn't one", async () => {
  const old = new Date(Date.now() - 90 * 86_400_000);
  await repository(join(root, "alpha"));
  await repository(join(root, "alpha", "nested"));
  await repository(join(root, "group", "beta"), "ref: refs/heads/feature/x");
  await repository(join(root, "group", "detached"), "0123456789abcdef");
  await repository(join(root, "old"), undefined, old);
  await repository(join(root, "build"));
  await repository(join(root, "a", "b", "c", "too-deep"));
  await repository(join(root, "node_modules", "pkg"));
  await repository(join(root, ".hidden", "repo"));
  await mkdir(join(root, "worktree"));
  await writeFile(join(root, "worktree", ".git"), "gitdir: /somewhere/else\n");
  await symlink(join(root, "alpha"), join(root, "link"));
  await mkdir(join(root, "empty-git", ".git"), { recursive: true });

  const progress: ScanProgress[] = [];
  const scan = await scanCodeFolder(root, { onProgress: (next) => progress.push(next) });
  expect(scan.folder).toBe(root);
  expect(scan.truncated).toBe(false);
  expect(scan.repositories.map((repo) => [repo.relative, repo.name, repo.branch])).toEqual([
    ["alpha", "alpha", "main"],
    ["build", "build", "main"],
    ["empty-git", "empty-git", null],
    [join("group", "beta"), "beta", "feature/x"],
    [join("group", "detached"), "detached", null],
    ["old", "old", "main"],
  ]);
  const found = Object.fromEntries(scan.repositories.map((repo) => [repo.name, repo]));
  expect(found["alpha"]?.path).toBe(join(root, "alpha"));
  expect(isRecent(found["alpha"]?.lastActive ?? null, Date.now())).toBe(true);
  expect(Math.abs((found["old"]?.lastActive ?? 0) - old.getTime())).toBeLessThan(1000);
  expect(isRecent(found["old"]?.lastActive ?? null, Date.now())).toBe(false);
  expect(found["empty-git"]?.lastActive).toBeNull();
  expect(isRecent(null, Date.now())).toBe(false);
  expect(progress.at(-1)).toEqual({ folders: scan.folders, repositories: 6 });
});

test("a real git repository and its linked worktree", async () => {
  const repo = join(root, "real");
  await mkdir(repo);
  const git = (...args: string[]) =>
    run("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: repo });
  await git("init", "-q", "-b", "trunk");
  await git("commit", "-q", "--allow-empty", "-m", "init");
  await git("worktree", "add", "-q", "-b", "side", join(root, "side-tree"));
  const scan = await scanCodeFolder(root);
  expect(scan.repositories.map((entry) => [entry.name, entry.branch])).toEqual([["real", "trunk"]]);
  expect(isRecent(scan.repositories[0]?.lastActive ?? null, Date.now())).toBe(true);
});

test("the folder itself can be a repository; limits, exclusions and bad input", async () => {
  await repository(root);
  expect((await scanCodeFolder(root)).repositories.map((repo) => repo.path)).toEqual([root]);
  await rm(join(root, ".git"), { recursive: true });

  for (let index = 0; index < 5; index++) await repository(join(root, `r${String(index)}`));
  const limited = await scanCodeFolder(root, { maxFolders: 3 });
  expect(limited).toMatchObject({ truncated: true, folders: 3 });
  const excluded = await scanCodeFolder(root, { exclude: [join(root, "r1"), join(root, "r2")] });
  expect(excluded.repositories.map((repo) => repo.name)).toEqual(["r0", "r3", "r4"]);
  expect((await scanCodeFolder(root, { maxDepth: 0 })).repositories).toEqual([]);

  await expect(scanCodeFolder("relative/path")).rejects.toThrow("Invalid folder");
  await expect(scanCodeFolder(join(root, "missing"))).rejects.toThrow();
  await writeFile(join(root, "file"), "");
  await expect(scanCodeFolder(join(root, "file"))).rejects.toThrow("Not a folder");
});

test("an unreadable folder is skipped, not fatal", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const { chmod } = await import("node:fs/promises");
  await repository(join(root, "ok"));
  await mkdir(join(root, "locked"));
  await chmod(join(root, "locked"), 0o000);
  try {
    expect((await scanCodeFolder(root)).repositories.map((repo) => repo.name)).toEqual(["ok"]);
  } finally {
    await chmod(join(root, "locked"), 0o700);
  }
});

test("suggests common code folders that exist", async () => {
  await mkdir(join(root, "code"));
  await mkdir(join(root, "Developer"));
  await writeFile(join(root, "src"), "a file, not a folder");
  expect(await suggestCodeFolders(root, "linux")).toEqual([join(root, "code")]);
  expect(await suggestCodeFolders(root, "darwin")).toEqual([
    join(root, "code"),
    join(root, "Developer"),
  ]);
});
