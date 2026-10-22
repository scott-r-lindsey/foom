import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { git as execute } from "../../../helpers/git.js";
import { nativeDeadline } from "../../../helpers/native-test-policy";
import { reviewSnapshot } from "../../../../src/main/workspace/review-snapshot";
import * as operations from "../../../../src/main/workspace/worktree-operations";

let root: string;
let tree: string;
let head: string;
let index: string;
let files: string[];
const identity = { launchIdentity: vi.fn(() => Promise.resolve("identity")) };
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "foom-review-snapshot-")));
  tree = join(root, "checkout");
  await mkdir(tree);
  head = "head";
  index = "index";
  files = [];
  identity.launchIdentity.mockReset().mockResolvedValue("identity");
  vi.spyOn(operations, "git").mockImplementation((_cwd, args) =>
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
const snapshot = () => reviewSnapshot(identity, root, tree, "identity");

describe("bounded worktree review snapshot", () => {
  it("detects HEAD, index, tracked, untracked, deleted and already-dirty byte changes", async () => {
    const empty = await snapshot();
    expect(await snapshot()).toEqual(empty);
    head = "next";
    expect(await snapshot()).not.toEqual(empty);
    head = "head";
    index = "staged";
    expect(await snapshot()).not.toEqual(empty);
    index = "index";
    files = ["a.ts"];
    await writeFile(join(tree, "a.ts"), "one");
    const one = await snapshot();
    await writeFile(join(tree, "a.ts"), "two");
    expect(await snapshot()).not.toEqual(one);
    await rm(join(tree, "a.ts"));
    expect(await snapshot()).not.toEqual(one);
    expect(operations.git).toHaveBeenCalledWith(
      tree,
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
      3000,
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
    await expect(snapshot()).rejects.toThrow("inside");
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
    vi.mocked(operations.git).mockImplementation((_cwd, args) => {
      if (args.includes("--git-path")) return Promise.resolve(join(tree, "missing"));
      if (args.includes("rev-parse")) {
        const current = head;
        head = "moved";
        return Promise.resolve(current);
      }
      return Promise.resolve("");
    });
    await expect(snapshot()).rejects.toThrow("Snapshot changed");
    files = ["a/absent"];
    vi.mocked(operations.git).mockImplementation((_cwd, args) =>
      Promise.resolve(
        args.includes("--git-path")
          ? join(tree, "missing")
          : args.includes("rev-parse")
            ? "head"
            : args.includes("--stage")
              ? "index"
              : files.join("\0"),
      ),
    );
    await expect(snapshot()).resolves.toMatchObject({ head: "head" });
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

it.each(["--skip-worktree", "--assume-unchanged"])(
  "detects %s index flags in both main and linked worktrees",
  { timeout: nativeDeadline(10000) },
  async (flag) => {
    vi.mocked(operations.git).mockImplementation(
      async (cwd, args) => (await execute(args, { cwd })).stdout,
    );
    const git = async (...args: string[]) => (await execute(args, { cwd: tree })).stdout;
    await git("init", "-b", "main");
    await writeFile(join(tree, "tracked"), "original");
    await git("add", "tracked");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Initial",
    );
    const main = tree;
    const linked = join(root, "linked");
    await git("worktree", "add", "-b", "review", linked);
    for (const checkout of [main, linked]) {
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

it.each(["index", "info/sparse-checkout", "info/exclude"])(
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
