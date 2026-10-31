import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { git as execute } from "../../../helpers/git.js";
import { nativeDeadline } from "../../../helpers/native-test-policy";
import { createHash } from "node:crypto";
import { remoteReviewSnapshot } from "../../../../src/terminal-host/remote/review-snapshot";
import * as operations from "../../../../src/terminal-host/remote/agent-discovery";

let root: string;
let tree: string;
let head: string;
let index: string;
let files: string[];
const indexEntry = (entry = "index", flags = "0") =>
  `${entry}\0  ctime: 0:0\n  mtime: 0:0\n  dev: 0\tino: 0\n  uid: 0\tgid: 0\n  size: 0\tflags: ${flags}\n`;
const identity = { launchIdentity: vi.fn(() => Promise.resolve("identity")) };
const digest = createHash("sha256").update("identity").digest("hex");
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "foom-review-snapshot-")));
  tree = join(root, "checkout");
  await mkdir(tree);
  head = "a".repeat(40);
  index = indexEntry();
  files = [];
  identity.launchIdentity.mockReset().mockResolvedValue("identity");
  vi.spyOn(operations, "remoteCheckout").mockImplementation(identity.launchIdentity);
  vi.spyOn(operations, "hostProbe").mockImplementation((_command, args) =>
    Promise.resolve(
      args.includes("--git-path")
        ? join(tree, `.git-${args.at(-1)?.replaceAll("/", "-") ?? ""}`)
        : args.includes("rev-parse")
          ? head + "\n"
          : args.includes("--stage")
            ? index
            : files.join("\0") + "\0",
    ),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const snapshot = () => remoteReviewSnapshot(root, tree, digest, { PATH: "/fixture" });

describe("bounded worktree review snapshot", () => {
  it("detects HEAD, index, tracked, untracked, deleted and already-dirty byte changes", async () => {
    const empty = await snapshot();
    expect(await snapshot()).toEqual(empty);
    head = "b".repeat(40);
    expect(await snapshot()).not.toEqual(empty);
    head = "a".repeat(40);
    index = indexEntry("staged");
    expect(await snapshot()).not.toEqual(empty);
    index = indexEntry();
    files = ["a.ts"];
    await writeFile(join(tree, "a.ts"), "one");
    const one = await snapshot();
    await writeFile(join(tree, "a.ts"), "two");
    expect(await snapshot()).not.toEqual(one);
    await rm(join(tree, "a.ts"));
    expect(await snapshot()).not.toEqual(one);
    expect(operations.hostProbe).toHaveBeenCalledWith(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      tree,
      { PATH: "/fixture" },
      false,
      3000,
      undefined,
      "review-snapshot",
    );
  });
  it.skipIf(process.platform === "win32")(
    "hashes symlink text without reading targets and refuses redirected ancestors",
    async () => {
      const secret = join(root, "outside");
      await writeFile(secret, "secret");
      await symlink(secret, join(tree, "link"));
      files = ["link"];
      const first = await snapshot();
      await writeFile(secret, "changed");
      expect(await snapshot()).toEqual(first);
      await rm(join(tree, "link"));
      await symlink("missing", join(tree, "link"));
      expect(await snapshot()).not.toEqual(first);
      await mkdir(join(root, "dir"));
      await writeFile(join(root, "dir", "a"), "outside");
      await symlink(join(root, "dir"), join(tree, "redirect"));
      files = ["redirect/a"];
      await expect(snapshot()).rejects.toThrow("Redirected");
      expect(await readFile(secret, "utf8")).toBe("changed");
    },
  );
  it("refuses replaced checkouts, oversized inventories, traversal and special-file/submodule directories", async () => {
    identity.launchIdentity.mockResolvedValueOnce("replacement");
    await expect(snapshot()).rejects.toThrow("Worktree changed");
    files = Array.from({ length: 10001 }, (_, i) => String(i));
    await expect(snapshot()).rejects.toThrow("capacity");
    files = ["invalid-\ufffd"];
    await expect(snapshot()).rejects.toThrow("Unsupported filename");
    files = ["../outside"];
    await expect(snapshot()).rejects.toThrow("Outside");
    await mkdir(join(tree, "submodule"));
    files = ["submodule"];
    await expect(snapshot()).rejects.toThrow("capacity");
    files = ["huge"];
    await writeFile(join(tree, "huge"), Buffer.alloc(32 * 1024 * 1024 + 1));
    await expect(snapshot()).rejects.toThrow("capacity");
  });
  it("rechecks identity and HEAD after collecting bytes and accepts deleted tracked paths", async () => {
    identity.launchIdentity.mockResolvedValueOnce("identity").mockResolvedValueOnce("replacement");
    await expect(snapshot()).rejects.toThrow("Worktree changed");
    vi.mocked(operations.hostProbe).mockImplementation((_command, args) => {
      if (args.includes("--git-path")) return Promise.resolve(join(tree, "missing"));
      if (args.includes("rev-parse")) {
        const current = head;
        head = "c".repeat(40);
        return Promise.resolve(current);
      }
      return Promise.resolve("");
    });
    await expect(snapshot()).rejects.toThrow("Snapshot changed");
    files = ["a/absent"];
    vi.mocked(operations.hostProbe).mockImplementation((_command, args) =>
      Promise.resolve(
        args.includes("--git-path")
          ? join(tree, "missing")
          : args.includes("rev-parse")
            ? "a".repeat(40)
            : args.includes("--stage")
              ? indexEntry()
              : files.join("\0"),
      ),
    );
    await expect(snapshot()).resolves.toMatchObject({ head: "a".repeat(40) });
  });
});

it("keeps file boundaries unambiguous when untracked files are merged", async () => {
  files = ["a", "b"];
  await writeFile(join(tree, "a"), "one");
  await writeFile(join(tree, "b"), "two");
  const initial = await snapshot();
  // Appending another file's old header and bytes must not preserve the digest.
  await writeFile(join(tree, "a"), `one${JSON.stringify(["b", 0o100644])}two`);
  await rm(join(tree, "b"));
  files = ["a"];
  expect(await snapshot()).not.toEqual(initial);
});

async function realWorktrees() {
  vi.mocked(operations.hostProbe).mockImplementation(
    async (_command, args, cwd) => (await execute([...args], { cwd })).stdout,
  );
  const git = async (...args: string[]) => (await execute(args, { cwd: tree })).stdout;
  await git("init", "-b", "main");
  await git("remote", "add", "origin", "https://fixture.test/o/r");
  await writeFile(join(tree, "tracked"), "original");
  await git("add", "tracked");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Initial");
  const main = tree;
  const linked = join(root, "linked");
  await git("worktree", "add", "-b", "review", linked);
  return { git, checkouts: [main, linked] };
}

it.skipIf(process.platform === "win32")(
  "snapshots a real linked checkout whose index and path inventories exceed ordinary probe output",
  { timeout: nativeDeadline(10000) },
  async () => {
    const { checkouts } = await realWorktrees();
    const repository = checkouts[0];
    const worktree = checkouts[1];
    if (!repository || !worktree) throw new Error("Missing fixture checkouts");
    const names = Array.from({ length: 1500 }, (_, i) => `file-${String(i)}-${"x".repeat(180)}`);
    await Promise.all(names.map((name) => writeFile(join(worktree, name), "")));
    await execute(["add", "--all"], { cwd: worktree });
    for (const args of [
      ["ls-files", "--stage", "-v", "--debug", "-z"],
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    ]) {
      const output = (await execute(args, { cwd: worktree, maxBuffer: 16 * 1024 * 1024 })).stdout;
      expect(Buffer.byteLength(output)).toBeGreaterThan(256 * 1024);
    }
    // Exercise production collection and checkout validation, not the small-data
    // Git adapter used by the semantic snapshot cases above.
    vi.mocked(operations.hostProbe).mockRestore();
    vi.mocked(operations.remoteCheckout).mockRestore();
    const env = operations.hostEnvironment();
    const checkout = createHash("sha256")
      .update(await operations.remoteCheckout(repository, worktree, env))
      .digest("hex");
    const evidence = await remoteReviewSnapshot(repository, worktree, checkout, env);
    expect(evidence.head).toBe(
      (await execute(["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim(),
    );
    expect(evidence.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(await remoteReviewSnapshot(repository, worktree, checkout, env)).toEqual(evidence);
  },
);

it.each(["--skip-worktree", "--assume-unchanged"])(
  "detects %s index flags in both main and linked worktrees",
  { timeout: nativeDeadline(10000) },
  async (flag) => {
    const { git, checkouts } = await realWorktrees();
    for (const checkout of checkouts) {
      tree = checkout;
      const before = await snapshot();
      const staged = await git("ls-files", "--stage");
      await git("update-index", flag, "tracked");
      expect(await git("ls-files", "--stage")).toBe(staged);
      expect(await snapshot()).not.toEqual(before);
      await writeFile(join(tree, "tracked"), "hidden edit");
      expect(await git("status", "--porcelain")).toBe("");
    }
  },
);

it.each(["info/sparse-checkout", "info/exclude"])(
  "detects changes to raw Git metadata %s",
  async (name) => {
    const path = join(tree, `.git-${name.replaceAll("/", "-")}`);
    const missing = await snapshot();
    await writeFile(path, "before");
    const before = await snapshot();
    expect(before).not.toEqual(missing);
    await writeFile(path, "after");
    expect(await snapshot()).not.toEqual(before);
  },
);

it("ignores touch followed by status/diff cache refresh in main and linked worktrees", {
  timeout: nativeDeadline(10000),
}, async () => {
  const { git, checkouts } = await realWorktrees();
  for (const checkout of checkouts) {
    tree = checkout;
    const path = join(tree, "tracked");
    const indexPath = (await git("rev-parse", "--git-path", "index")).trim();
    const before = await snapshot();
    const rawBefore = await readFile(resolve(tree, indexPath));
    const previous = await stat(path);
    // Force a distinct mtime without sleeping or modifying content.
    await utimes(path, previous.atime, new Date(previous.mtimeMs + 10000));
    expect(await git("status", "--porcelain")).toBe("");
    expect(await git("diff")).toBe("");
    expect(await readFile(resolve(tree, indexPath))).not.toEqual(rawBefore);
    expect(await snapshot()).toEqual(before);
  }
});

it("detects intent-to-add becoming an ordinary staged empty file in both worktrees", {
  timeout: nativeDeadline(10000),
}, async () => {
  const { git, checkouts } = await realWorktrees();
  for (const checkout of checkouts) {
    tree = checkout;
    await writeFile(join(tree, "empty"), "");
    await git("add", "-N", "empty");
    const intent = await snapshot();
    const entries = await git("ls-files", "--stage", "-v", "-z");
    await git("add", "empty");
    expect(await git("ls-files", "--stage", "-v", "-z")).toBe(entries);
    expect(await snapshot()).not.toEqual(intent);
  }
});

it.each(["missing terminator", "entry\0unsupported metadata\n"])(
  "refuses unsupported index debug output %j",
  async (output) => {
    index = output;
    await expect(snapshot()).rejects.toThrow("Unsupported index metadata");
  },
);

it("keeps flags distinct from newline-containing filenames and ignores nonsemantic cache bits", async () => {
  index = indexEntry("H mode object 0\tname\n  size: 0\tflags: 20000000");
  const before = await snapshot();
  index = indexEntry("H mode object 0\tname\n  size: 0\tflags: 20000000", "200000");
  expect(await snapshot()).toEqual(before);
  index = indexEntry("H mode object 0\tname\n  size: 0\tflags: 20000000", "20000000");
  expect(await snapshot()).not.toEqual(before);
});

it("refuses malformed HEAD and cancelled snapshots without reading bytes", async () => {
  head = "invalid";
  await expect(snapshot()).rejects.toThrow("Invalid HEAD");
  const cancellation = new AbortController();
  cancellation.abort();
  await expect(remoteReviewSnapshot(root, tree, digest, {}, cancellation.signal)).rejects.toThrow();
});

it("pins branch and origin as well as HEAD, and refuses a context change during the read", async () => {
  let branch = "refs/heads/review";
  let origin = "https://fixture.test/o/r";
  let reads = 0;
  let racing = false;
  const original = vi.mocked(operations.hostProbe).getMockImplementation();
  if (!original) throw new Error("Missing fixture probe");
  vi.mocked(operations.hostProbe).mockImplementation((...args) => {
    if (args[1].includes("--symbolic-full-name")) return Promise.resolve(branch);
    if (args[1].includes("config")) {
      if (racing && reads++ > 0) origin = "https://fixture.test/changed/r";
      return Promise.resolve(origin);
    }
    return original(...args);
  });
  const initial = await snapshot();
  branch = "refs/heads/other";
  expect(await snapshot()).not.toEqual(initial);
  branch = "refs/heads/review";
  origin = "https://fixture.test/other/r";
  expect(await snapshot()).not.toEqual(initial);
  racing = true;
  await expect(snapshot()).rejects.toThrow("Snapshot changed");
});
