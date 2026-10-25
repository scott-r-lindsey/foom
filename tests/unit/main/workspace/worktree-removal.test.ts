import { mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeService } from "../../../../src/main/workspace/worktrees";
import { git as execute } from "../../../helpers/git.js";
import { nativeDeadline } from "../../../helpers/native-test-policy";
import { createWorktreeFixture } from "./worktree-git-fixture";

// Real Git startup and filesystem IO are slower on Windows (run 39076862694).
vi.setConfig({ testTimeout: nativeDeadline(5000), hookTimeout: nativeDeadline(10_000) });

const fixture = createWorktreeFixture();
const usingFixture = fixture.usingFixture;

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
    ({ temporary, repo, root, service } = await fixture.create());
  }),
);
afterEach(async () => {
  await fixture.cleanup();
});

describe("safe removal", () => {
  it.each(["local", "remote", "tag", "unreachable"])(
    "detached reviewer requires a ref (%s)",
    async (kind) => {
      const { path } = await service.createWorktree(repo, "review");
      const identity = await service.launchIdentity(repo, path);
      await execute(["checkout", "--detach"], { cwd: path });
      await execute(
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "Review head",
        ],
        { cwd: path },
      );
      const head = (await execute(["rev-parse", "HEAD"], { cwd: path })).stdout.trim();
      if (kind !== "unreachable") {
        const ref =
          kind === "local"
            ? "refs/heads/pr"
            : kind === "remote"
              ? "refs/remotes/origin/pr"
              : "refs/tags/pr";
        await git("update-ref", ref, head);
      }
      expect(await service.launchIdentity(repo, path)).toBe(identity);
      if (kind === "unreachable") {
        await expect(service.removeWorktree(repo, path, true, identity)).rejects.toMatchObject({
          reason: "detached_head",
        });
        expect(await realpath(path)).toBe(path);
      } else {
        await service.removeWorktree(repo, path, false, identity);
        await expect(realpath(path)).rejects.toThrow();
      }
    },
  );

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
    await expect(service.removeWorktree(repo, path)).rejects.toMatchObject({
      reason: kind === "untracked" ? "untracked_files" : "dirty",
    });
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
    "sparse-without-index-flags",
    "invalid-sparse-config",
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
    if (mode === "sparse-without-index-flags") {
      await execute(["sparse-checkout", "init", "--no-cone"], { cwd: path });
      await execute(["sparse-checkout", "set", "--no-cone", "/*"], { cwd: path });
      expect((await execute(["ls-files", "-v"], { cwd: path })).stdout).toBe("H tracked.txt\n");
    }
    if (mode === "invalid-sparse-config")
      await execute(["config", "core.sparseCheckout", "invalid"], { cwd: path });
    if (mode === "git-error")
      vi.spyOn(service, "cleanupStatus").mockRejectedValueOnce(new Error("Git failed"));
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

it.each([
  "empty",
  "missing",
  "leftovers",
  "index",
  "unpushed",
  "private refs",
  "operation",
  "unknown",
  "redirected",
])("broken-row cleanup fails closed around real Git %s", async (mode) => {
  const { path } = await service.createWorktree(repo, "broken-review");
  await git("clone", "--bare", repo, join(temporary, "remote.git"));
  await git("remote", "add", "origin", join(temporary, "remote.git"));
  await git("fetch", "origin");
  if (mode === "index") {
    await writeFile(join(path, "staged.txt"), "uncommitted blob");
    await execute(["add", "."], { cwd: path });
    await rm(join(path, "staged.txt"));
  }
  if (mode === "private refs")
    await execute(["update-ref", "refs/worktree/saved", "HEAD"], { cwd: path });
  if (mode === "operation") {
    const admin = (
      await execute(["rev-parse", "--path-format=absolute", "--git-path", "rebase-apply"], {
        cwd: path,
      })
    ).stdout.trim();
    await mkdir(admin);
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
        "local",
      ],
      { cwd: path },
    );
  await rm(join(path, ".git"));
  if (mode === "leftovers") await writeFile(join(path, ".env"), "do not delete");
  if (mode === "missing") await rm(path, { recursive: true });
  if (mode === "redirected") {
    await rename(path, join(temporary, "redirect-target"));
    await symlink(join(temporary, "redirect-target"), path, "junction");
  }
  const target = mode === "unknown" ? repo : path;
  if (mode === "empty" || mode === "missing") {
    await service.cleanupBrokenWorktree(repo, target);
    expect((await service.listWorktrees(repo)).some((tree) => tree.path === path)).toBe(false);
  } else {
    await expect(service.cleanupBrokenWorktree(repo, target)).rejects.toThrow();
    expect((await service.listWorktrees(repo)).some((tree) => tree.path === path)).toBe(true);
    if (mode === "leftovers")
      expect(await readFile(join(path, ".env"), "utf8")).toBe("do not delete");
  }
});

it.each(["refs/bisect/saved", "refs/rewritten/saved"])(
  "refuses private %s even with a clean detached checkout",
  async (ref) => {
    const { path } = await service.createWorktree(repo, "private-review");
    await execute(["checkout", "--detach"], { cwd: path });
    await execute(["update-ref", ref, "HEAD"], { cwd: path });
    await expect(service.cleanupStatus(repo, path)).rejects.toThrow("Worktree-private refs");
  },
);

it("refuses .gitmodules even without index gitlinks", async () => {
  const { path } = await service.createWorktree(repo, "modules-review");
  await writeFile(join(path, ".gitmodules"), "untracked config");
  await expect(service.cleanupStatus(repo, path)).rejects.toThrow("Submodules");
});

it("preserves legacy explicit removal behavior for ignored files", async () => {
  const { path } = await service.createWorktree(repo, "legacy-ignored");
  await execute(["config", "core.excludesFile", join(temporary, "excludes")], { cwd: path });
  await writeFile(join(temporary, "excludes"), ".env\n");
  await writeFile(join(path, ".env"), "legacy undisclosed ignored content");
  expect(await service.changes(repo, path)).toBe("");
  await service.removeWorktree(repo, path);
  await expect(realpath(path)).rejects.toThrow();
});

it.each(["nested repository", "reset reflog", "redirected config"])(
  "refuses round-four real Git data loss: %s",
  async (scenario) => {
    if (scenario !== "reset reflog") {
      await mkdir(join(repo, "nested"));
      await writeFile(join(repo, "nested", "tracked.txt"), "original");
      await git("add", ".");
      await git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "Tracked",
      );
    }
    const { path } = await service.createWorktree(repo, "round-four");
    await git("clone", "--bare", repo, join(temporary, "remote.git"));
    await git("remote", "add", "origin", join(temporary, "remote.git"));
    await git("fetch", "origin");
    const admin = (await execute(["rev-parse", "--absolute-git-dir"], { cwd: path })).stdout.trim();
    if (scenario === "nested repository") {
      const nested = join(path, "nested");
      await execute(["init"], { cwd: nested });
      await execute(["add", "."], { cwd: nested });
      await execute(
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "Unique nested history",
        ],
        { cwd: nested },
      );
      expect((await execute(["status", "--porcelain"], { cwd: path })).stdout).toBe("");
      await expect(service.cleanupChanges(repo, path)).rejects.toThrow();
      expect(await stat(join(nested, ".git", "objects"))).toBeTruthy();
    } else if (scenario === "reset reflog") {
      await execute(
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "Only reflog keeps this secret",
        ],
        { cwd: path },
      );
      const secret = (await execute(["rev-parse", "HEAD"], { cwd: path })).stdout.trim();
      await execute(["reset", "--hard", "origin/main"], { cwd: path });
      await rm(join(path, ".git"));
      await expect(service.cleanupBrokenWorktree(repo, path)).rejects.toThrow();
      expect(await readFile(join(admin, "logs", "HEAD"), "utf8")).toContain(secret);
    } else {
      const mirror = join(temporary, "mirror");
      await mkdir(join(mirror, "nested"), { recursive: true });
      await writeFile(join(mirror, "nested", "tracked.txt"), "original");
      await writeFile(join(mirror, "screenshot.png"), "disclosed mirror image");
      await writeFile(join(path, "nested", "tracked.txt"), "hidden tracked edit");
      await writeFile(join(path, "screenshot.png"), "actual image");
      await git("config", "extensions.worktreeConfig", "true");
      await git("config", "--file", join(admin, "config.worktree"), "core.worktree", mirror);
      expect((await execute(["status", "--porcelain"], { cwd: path })).stdout).toBe(
        "?? screenshot.png\n",
      );
      await expect(service.cleanupChanges(repo, path)).rejects.toThrow();
      expect(await readFile(join(path, "nested", "tracked.txt"), "utf8")).toBe(
        "hidden tracked edit",
      );
    }
  },
);

it.each([
  "ignored nested repo",
  "untracked nested marker",
  "deep walk",
  "missing HEAD log",
  "invalid log",
  "incomplete log",
  "oversized log",
  "private log",
  "symlinked log",
  "symlinked logs directory",
  "disabled worktree config file",
  "enabled worktree config",
  "clean filter",
  "safe symlink",
])("fails closed on cleanup evidence: %s", async (mode) => {
  const { path } = await service.createWorktree(repo, "evidence");
  await git("clone", "--bare", repo, join(temporary, "remote.git"));
  await git("remote", "add", "origin", join(temporary, "remote.git"));
  await git("fetch", "origin");
  const admin = (await execute(["rev-parse", "--absolute-git-dir"], { cwd: path })).stdout.trim();
  const logs = join(admin, "logs");
  if (mode === "ignored nested repo" || mode === "untracked nested marker") {
    await mkdir(join(path, "nested"));
    if (mode === "ignored nested repo") {
      await writeFile(join(path, ".gitignore"), "nested/\n");
      await execute(["init"], { cwd: join(path, "nested") });
    } else await writeFile(join(path, "nested", ".git"), "independent metadata");
  }
  if (mode === "deep walk") {
    let directory = path;
    for (let depth = 0; depth < 66; depth++) {
      directory = join(directory, "d");
      await mkdir(directory);
    }
  }
  if (mode === "missing HEAD log") await rm(join(logs, "HEAD"));
  if (mode === "invalid log") await writeFile(join(logs, "HEAD"), "unreadable revision\n");
  if (mode === "incomplete log") await writeFile(join(logs, "HEAD"), "truncated");
  if (mode === "oversized log")
    await writeFile(join(logs, "HEAD"), "x".repeat(4 * 1024 * 1024 + 1));
  if (mode === "private log") {
    await execute(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "unpublished",
      ],
      { cwd: path },
    );
    const localLog = await readFile(join(logs, "HEAD"));
    await execute(["reset", "--hard", "origin/main"], { cwd: path });
    await mkdir(join(logs, "refs", "worktree"), { recursive: true });
    await writeFile(join(logs, "refs", "worktree", "saved"), localLog);
    const initial = localLog.toString().slice(0, localLog.indexOf("\n"));
    await writeFile(join(logs, "HEAD"), `${initial}\n`);
  }
  if (mode === "symlinked log" || mode === "symlinked logs directory") {
    // Junctions work without elevated Windows symlink privileges.
    if (mode === "symlinked log") await symlink(repo, join(logs, "linked"), "junction");
    else {
      await rename(logs, join(temporary, "saved-logs"));
      await symlink(join(temporary, "saved-logs"), logs, "junction");
    }
  }
  if (mode === "disabled worktree config file") await writeFile(join(admin, "config.worktree"), "");
  if (mode === "enabled worktree config") await git("config", "extensions.worktreeConfig", "true");
  if (mode === "clean filter")
    await git("config", "filter.hide.clean", "irrelevant-fixture-command");
  if (mode === "safe symlink") {
    await symlink(repo, join(path, "external"), "junction");
    expect(await service.cleanupChanges(repo, path)).toContain("?? external");
  } else await expect(service.cleanupChanges(repo, path)).rejects.toThrow();
  expect(await stat(path)).toBeTruthy();
});

it("isolates cleanup reads from global and system filter configuration", async () => {
  const { path } = await service.createWorktree(repo, "global-filters");
  await git("clone", "--bare", repo, join(temporary, "remote.git"));
  await git("remote", "add", "origin", join(temporary, "remote.git"));
  await git("fetch", "origin");
  const home = join(temporary, "fixture-home");
  const config = join(home, "config");
  await mkdir(join(config, "git"), { recursive: true });
  await writeFile(
    join(config, "git", "config"),
    '[filter "fixture"]\nclean = fixture-must-not-run\n',
  );
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CONFIG_HOME", config);
  expect(await service.cleanupChanges(repo, path)).toBe("");
});

it.skipIf(process.platform !== "linux")(
  "refuses ambiguous filename decoding without overlooking a nested repository",
  async () => {
    const rawDirectory = (base: string) =>
      Buffer.concat([Buffer.from(`${base}/`), Buffer.from([0xff])]);
    const rawFile = (base: string, suffix: string) =>
      Buffer.concat([rawDirectory(base), Buffer.from(`/${suffix}`)]);
    await mkdir(rawDirectory(repo));
    await mkdir(join(repo, "\ufffd"));
    await writeFile(rawFile(repo, "tracked.txt"), "outer contents");
    await writeFile(join(repo, "\ufffd", "tracked.txt"), "outer contents");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Distinct raw and Unicode names",
    );
    const { path } = await service.createWorktree(repo, "raw-nested-review");
    await git("clone", "--bare", repo, join(temporary, "remote.git"));
    await git("remote", "add", "origin", join(temporary, "remote.git"));
    await git("fetch", "origin");
    const nested = join(temporary, "independent");
    await mkdir(nested);
    await execute(["init", "-b", "main"], { cwd: nested });
    await writeFile(join(nested, "tracked.txt"), "outer contents");
    await execute(["add", "."], { cwd: nested });
    await execute(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "Independent nested history",
      ],
      { cwd: nested },
    );
    await rename(join(nested, ".git"), rawFile(path, ".git"));
    expect((await execute(["status", "--porcelain"], { cwd: path })).stdout).toBe("");
    await expect(service.cleanupChanges(repo, path)).rejects.toThrow();
    expect((await stat(rawFile(path, ".git/objects"))).isDirectory()).toBe(true);
  },
);

it("refuses a valueless worktree configuration boolean", async () => {
  const { path } = await service.createWorktree(repo, "valueless-config");
  await git("clone", "--bare", repo, join(temporary, "remote.git"));
  await git("remote", "add", "origin", join(temporary, "remote.git"));
  await git("fetch", "origin");
  const config = join(repo, ".git", "config");
  await writeFile(config, `${await readFile(config, "utf8")}\n[extensions]\nworktreeConfig\n`);
  expect(
    (
      await execute(["config", "--bool", "--get", "extensions.worktreeConfig"], { cwd: path })
    ).stdout.trim(),
  ).toBe("true");
  await expect(service.cleanupChanges(repo, path)).rejects.toThrow("configuration");
});

it.each(["false", "0", "off", "no", ""])(
  "accepts disabled sparse configuration %j in the audited config read",
  async (value) => {
    const { path } = await service.createWorktree(repo, "disabled-sparse");
    await git("clone", "--bare", repo, join(temporary, "remote.git"));
    await git("remote", "add", "origin", join(temporary, "remote.git"));
    await git("fetch", "origin");
    await execute(["config", "core.sparseCheckout", value], { cwd: path });
    expect(await service.cleanupChanges(repo, path)).toBe("");
  },
);

it.each(["ident", "working-tree-encoding=UTF-8"])(
  "refuses tracked status conversion %s before leftover cleanup",
  async (attribute) => {
    await writeFile(join(repo, ".gitattributes"), `tracked.txt ${attribute}\n`);
    await writeFile(join(repo, "tracked.txt"), attribute === "ident" ? "$Id$\n" : "original\n");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Attributes",
    );
    const { path } = await service.createWorktree(repo, "status-conversion");
    await git("clone", "--bare", repo, join(temporary, "remote.git"));
    await git("remote", "add", "origin", join(temporary, "remote.git"));
    await git("fetch", "origin");
    if (attribute === "ident")
      await writeFile(join(path, "tracked.txt"), `$Id: ${"a".repeat(40)} $\n`);
    await writeFile(join(path, "screenshot.png"), "approved image");
    expect((await execute(["status", "--porcelain"], { cwd: path })).stdout).toBe(
      "?? screenshot.png\n",
    );
    await expect(service.cleanupChanges(repo, path)).rejects.toThrow();
    expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe(
      attribute === "ident" ? `$Id: ${"a".repeat(40)} $\n` : "original\n",
    );
  },
);

it.each(["text eol=lf", "-ident -working-tree-encoding"])(
  "allows ordinary tracked attributes %s",
  async (attribute) => {
    await writeFile(join(repo, ".gitattributes"), `tracked.txt ${attribute}\n`);
    await writeFile(join(repo, "tracked.txt"), "original\n");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Attributes",
    );
    const { path } = await service.createWorktree(repo, "ordinary-attributes");
    await git("clone", "--bare", repo, join(temporary, "remote.git"));
    await git("remote", "add", "origin", join(temporary, "remote.git"));
    await git("fetch", "origin");
    await writeFile(join(path, "screenshot.png"), "approved image");
    expect(await service.cleanupChanges(repo, path)).toBe("?? screenshot.png\0");
  },
);
