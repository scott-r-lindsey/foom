import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, test } from "vitest";
import { worktreeIdentity } from "../../../../src/main/workspace/worktree-operations";
import { git } from "../../../helpers/git.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foom-identity-")));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const run = (args: string[]) => git(args, { cwd: repo });
  await run(["init", "-q", "-b", "main"]);
  await run([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "init",
  ]);
  return { root, repo, run };
}

test("reads main, linked and relative Git markers with the same canonical identity as Git", async () => {
  const { root, repo, run } = await fixture();
  const checkout = join(root, "linked");
  await run(["worktree", "add", "-b", "linked", checkout]);
  for (const directory of [repo, checkout]) {
    const { stdout } = await git(["rev-parse", "--absolute-git-dir"], { cwd: directory });
    const canonical = await realpath(stdout.trimEnd());
    const entries = await Promise.all(
      [directory, join(directory, ".git"), canonical].map(async (entry) => {
        const metadata = await lstat(entry, { bigint: true });
        return [metadata.dev, metadata.ino, metadata.birthtimeNs].map(String);
      }),
    );
    expect(await worktreeIdentity(directory)).toBe(JSON.stringify([canonical, entries]));
  }
  const original = await worktreeIdentity(checkout);
  const marker = join(checkout, ".git");
  const target = (await readFile(marker, "utf8")).slice(8).trimEnd();
  await writeFile(marker, `gitdir: ${relative(checkout, target)}\n`);
  expect(await worktreeIdentity(checkout)).toBe(original);
  const alias = join(root, "alias");
  await symlink(checkout, alias, "junction");
  expect(await worktreeIdentity(alias)).not.toBe(original);
  await rm(marker);
  await expect(worktreeIdentity(checkout)).rejects.toThrow();
});

test("refuses malformed, oversized, missing and unreadable Git marker targets", async () => {
  const { root } = await fixture();
  const checkout = join(root, "fake");
  await mkdir(checkout);
  const marker = join(checkout, ".git");
  for (const text of [
    "",
    "other",
    "gitdir: ",
    "gitdir: a\0",
    "gitdir: a\nb",
    `gitdir: ${"x".repeat(64 * 1024 + 1)}`,
    "gitdir: missing\n",
  ]) {
    await writeFile(marker, text);
    await expect(worktreeIdentity(checkout)).rejects.toThrow();
  }
});

test.skipIf(process.platform === "win32")(
  "refuses non-regular Git markers without waiting for input",
  async () => {
    const { root } = await fixture();
    const checkout = join(root, "fake");
    await mkdir(checkout);
    await symlink("/dev/null", join(checkout, ".git"));
    await expect(worktreeIdentity(checkout)).rejects.toThrow("Invalid Git marker");
  },
);
