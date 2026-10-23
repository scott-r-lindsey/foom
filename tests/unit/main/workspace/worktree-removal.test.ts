import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeService } from "../../../../src/main/workspace/worktrees";
import { git as execute } from "../../../helpers/git.js";
import { nativeDeadline } from "../../../helpers/native-test-policy";

// Real Git startup and filesystem IO are slower on Windows (run 39076862694).
vi.setConfig({ testTimeout: nativeDeadline(5000), hookTimeout: nativeDeadline(10_000) });

// Vitest timeouts do not cancel async callbacks. Keep the entire operation alive
// through teardown, including any Git commands it starts after the timeout.
let fixtureWork: Promise<void> | undefined;
function usingFixture(work: () => Promise<void>): () => Promise<void> {
  return () => {
    fixtureWork = work();
    return fixtureWork;
  };
}

let temporary: string;
let repo: string;
let root: string;
let service: WorktreeService;
async function git(...args: string[]): Promise<string> {
  const { stdout } = await execute(args, { cwd: repo });
  return stdout;
}
beforeEach(
  usingFixture(async () => {
    temporary = await realpath(await mkdtemp(join(tmpdir(), "foom-worktrees-")));
    repo = join(temporary, "repo with spaces");
    root = join(temporary, "root");
    await mkdir(repo);
    await git("init", "-b", "main");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "Initial",
    );
    service = new WorktreeService(root);
    await service.addRepository(repo);
  }),
);
afterEach(async () => {
  await Promise.allSettled(fixtureWork ? [fixtureWork] : []);
  fixtureWork = undefined;
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

describe("safe removal", () => {
  it.each(["untracked", "tracked", "staged"])("refuses %s changes unless forced", async (kind) => {
    const { path } = await service.createWorktree(repo, "dirty");
    const file = join(path, "file");
    await writeFile(file, "original");
    if (kind !== "untracked") {
      await execute(["add", "file"], { cwd: path });
      if (kind === "tracked") {
        await execute(
          ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "File"],
          { cwd: path },
        );
        await writeFile(file, "changed");
      }
    }
    await expect(service.removeWorktree(repo, path)).rejects.toThrow();
    expect(await realpath(path)).toBe(path);
    await service.removeWorktree(repo, path, true);
    await expect(realpath(path)).rejects.toThrow();
  });
  it("allows removal after restart but rejects another repository and the main checkout", async () => {
    const { path } = await service.createWorktree(repo, "owned");
    const fresh = new WorktreeService(root);
    await fresh.addRepository(repo);
    expect(await fresh.removalIdentity(repo, path)).toBeTruthy();
    const other = join(temporary, "other");
    await mkdir(other);
    await execute(["init"], { cwd: other });
    await service.addRepository(other);
    await expect(service.removeWorktree(other, path, true)).rejects.toThrow("worktree-missing");
    await expect(service.removeWorktree(repo, repo, true)).rejects.toThrow("worktree-main");
    await expect(service.removeWorktree(repo, "\0")).rejects.toThrow("Invalid path");
    await fresh.removeWorktree(repo, path);
    await expect(realpath(path)).rejects.toThrow();
  });
  it("refuses redirected owned worktrees", async () => {
    const { path } = await service.createWorktree(repo, "redirected");
    const moved = join(temporary, "moved");
    await rename(path, moved);
    await symlink(moved, path, "junction");
    await expect(service.removeWorktree(repo, path, true)).rejects.toThrow("redirected");
    expect(await realpath(moved)).toBe(moved);
  });
  it("respects Git locks, including on forced removal", async () => {
    const { path } = await service.createWorktree(repo, "locked");
    await git("worktree", "lock", path);
    await expect(service.removeWorktree(repo, path, true)).rejects.toThrow();
    await git("worktree", "unlock", path);
    await service.removeWorktree(repo, path);
  });
});

it.each([false, true])(
  "rejects replacements after identity capture (list first: %s)",
  async (listFirst) => {
    const { path } = await service.createWorktree(repo, "owned");
    const identity = await service.removalIdentity(repo, path);
    await git("worktree", "remove", path);
    await git("worktree", "add", "-b", "external", path);
    await writeFile(join(path, "valuable"), "keep me");
    if (listFirst) {
      expect(await service.listWorktrees(repo)).toContainEqual(
        expect.objectContaining({ path, managed: false }),
      );
    }
    for (const force of [false, true]) {
      await expect(service.removeWorktree(repo, path, force, identity)).rejects.toThrow("replaced");
      expect(await readFile(join(path, "valuable"), "utf8")).toBe("keep me");
    }
  },
);

it("invalidates ownership when metadata disappears", async () => {
  const { path } = await service.createWorktree(repo, "missing");
  await rm(join(path, ".git"));
  expect(await service.listWorktrees(repo)).toContainEqual(
    expect.objectContaining({ path, managed: false }),
  );
  await expect(service.removeWorktree(repo, path, true)).rejects.toThrow("worktree-prunable");
});

it("preserves ownership across ordinary branch and file changes", async () => {
  const { path } = await service.createWorktree(repo, "owned");
  await execute(["checkout", "-b", "renamed"], { cwd: path });
  await writeFile(join(path, "new-file"), "content");
  expect(await service.listWorktrees(repo)).toContainEqual(
    expect.objectContaining({ path, branch: "renamed", managed: true }),
  );
  await service.removeWorktree(repo, path, true);
});

describe("pruning stale worktrees", () => {
  it(
    "prunes only the named repository, removes its recorded leftover folder and keeps branches",
    usingFixture(async () => {
      const { path } = await service.createWorktree(repo, "stale");
      await writeFile(join(path, "leftover"), "leftover");
      await rm(join(path, ".git"));
      await expect(service.removalIdentity(repo, path)).rejects.toThrow("worktree-prunable");
      const other = join(temporary, "other-repo");
      await mkdir(other);
      await execute(["init", "-b", "main"], { cwd: other });
      await execute(
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "init",
        ],
        { cwd: other },
      );
      const otherTree = join(temporary, "other-tree");
      await execute(["worktree", "add", "-b", "other", otherTree], { cwd: other });
      await rm(otherTree, { recursive: true });
      await service.pruneWorktree(repo, path);
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await git("branch", "--list", "stale")).toContain("stale");
      expect((await service.listWorktrees(repo)).map((tree) => tree.path)).toEqual([repo]);
      expect((await execute(["worktree", "list", "--porcelain"], { cwd: other })).stdout).toContain(
        otherTree,
      );
    }),
  );

  it(
    "prunes a missing folder without deleting anything else",
    usingFixture(async () => {
      const { path } = await service.createWorktree(repo, "gone");
      await rm(path, { recursive: true });
      await service.pruneWorktree(repo, path);
      expect(await service.listWorktrees(repo)).toHaveLength(1);
      expect(await git("branch", "--list", "gone")).toContain("gone");
    }),
  );

  it(
    "refuses unknown repositories, unrecorded paths, live, locked and main checkouts",
    usingFixture(async () => {
      const { path } = await service.createWorktree(repo, "live");
      await expect(service.pruneWorktree(temporary, path)).rejects.toThrow("not been added");
      for (const target of [repo, root, path])
        await expect(service.pruneWorktree(repo, target)).rejects.toThrow("prune-unsafe");
      await git("worktree", "lock", path);
      await rm(join(path, ".git"));
      await expect(service.pruneWorktree(repo, path)).rejects.toThrow("prune-unsafe");
      expect(await git("worktree", "list", "--porcelain")).toContain(path);
    }),
  );

  it(
    "refuses recorded paths outside the managed root",
    usingFixture(async () => {
      const path = join(temporary, "external");
      await git("worktree", "add", "-b", "external", path);
      await rm(join(path, ".git"));
      await writeFile(join(path, "keep"), "keep");
      await expect(service.pruneWorktree(repo, path)).rejects.toThrow("prune-unsafe");
      expect(await readFile(join(path, "keep"), "utf8")).toBe("keep");
      expect(await git("worktree", "list", "--porcelain")).toContain(path);
    }),
  );

  it(
    "refuses any .git entry, even when Git reports the checkout as prunable",
    usingFixture(async () => {
      const { path } = await service.createWorktree(repo, "still-git");
      const inventory = await service.listWorktrees(repo);
      vi.spyOn(service, "listWorktrees").mockResolvedValue(
        inventory.map((tree) => ({ ...tree, prunable: tree.path === path })),
      );
      await expect(service.pruneWorktree(repo, path)).rejects.toThrow("prune-unsafe");
      await rm(join(path, ".git"));
      await mkdir(join(path, ".git"));
      await expect(service.pruneWorktree(repo, path)).rejects.toThrow("prune-unsafe");
    }),
  );

  it(
    "refuses symlinked folders and parent components",
    usingFixture(async () => {
      const { path } = await service.createWorktree(repo, "linked");
      await rm(join(path, ".git"));
      const moved = join(temporary, "moved");
      await rename(path, moved);
      await symlink(moved, path, process.platform === "win32" ? "junction" : "dir");
      await expect(service.pruneWorktree(repo, path)).rejects.toThrow("prune-unsafe");
      await rm(path);
      await rename(moved, path);
      const parent = dirname(path);
      const movedParent = join(temporary, "moved-parent");
      await rename(parent, movedParent);
      await symlink(movedParent, parent, process.platform === "win32" ? "junction" : "dir");
      await expect(service.pruneWorktree(repo, path)).rejects.toThrow("prune-unsafe");
      expect(await git("worktree", "list", "--porcelain")).toContain(path);
    }),
  );
});

// These restrictions belong to group cleanup; explicit removal retains its
// existing dirty/external-checkout confirmation policy.
describe("new group cleanup guards", () => {
  it.each([
    "branch",
    "detached",
    "untracked",
    "tracked",
    "staged",
    "unpushed",
    "no-remote",
    "outside",
    "redirected",
    "git-error",
  ])("checks %s checkouts with real Git", async (mode) => {
    const { path } = await service.createWorktree(repo, "cleanup");
    await writeFile(join(path, "tracked.txt"), "original");
    await execute(["add", "."], { cwd: path });
    await execute(
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "tracked"],
      { cwd: path },
    );
    if (mode !== "no-remote") {
      // A local bare fixture is the only remote. No network or real worktrees.
      const remote = join(temporary, "remote.git");
      await git("clone", "--bare", repo, remote);
      await git("remote", "add", "origin", remote);
      await git("fetch", "origin");
    }
    let target = path;
    if (mode === "outside") {
      target = join(temporary, "external");
      await git("worktree", "add", "--detach", target, "cleanup");
    }
    if (mode === "redirected") {
      const moved = join(temporary, "moved-cleanup");
      await rename(path, moved);
      await symlink(moved, path, "junction");
    }
    if (mode === "detached") await execute(["checkout", "--detach"], { cwd: path });
    if (mode === "untracked") await writeFile(join(path, "screenshots.png"), "evidence");
    if (mode === "tracked" || mode === "staged") {
      await writeFile(join(path, "tracked.txt"), "changed");
      if (mode === "staged") await execute(["add", "."], { cwd: path });
    }
    if (mode === "unpushed")
      await execute(
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "local only",
        ],
        { cwd: path },
      );
    if (mode === "git-error")
      vi.spyOn(service, "changes").mockRejectedValueOnce(new Error("Git failed"));
    if (["branch", "detached", "untracked"].includes(mode)) {
      const identity = await service.removalIdentity(repo, target);
      expect(await service.cleanupChanges(repo, target, identity)).toBe(
        mode === "untracked" ? "?? screenshots.png\0" : "",
      );
    } else await expect(service.cleanupChanges(repo, target)).rejects.toThrow();
    expect(await stat(target)).toBeTruthy();
  });
});

it("prunes an empty broken folder", async () => {
  const { path } = await service.createWorktree(repo, "empty-broken");
  await rm(join(path, ".git"));
  await service.pruneWorktree(repo, path);
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await git("branch", "--list", "empty-broken")).toContain("empty-broken");
});
