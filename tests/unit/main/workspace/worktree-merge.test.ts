import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import type { WorkspaceDependencies } from "../../../../src/main/workspace/workspace-types";
import { WorktreeService } from "../../../../src/main/workspace/worktrees";
import { git as execute } from "../../../helpers/git.js";
import { forgeProvider } from "../../../helpers/legacy-forge";
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

describe("merged worktree containment", () => {
  beforeEach(async () => {
    // Do not let a developer's global identity conceal missing fixture arguments.
    await git("config", "user.name", "");
    await git("config", "user.email", "");
  });
  async function commit(cwd: string, message: string) {
    await execute(["add", "."], { cwd });
    await execute(
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message],
      { cwd },
    );
  }
  async function remote() {
    const remote = join(temporary, "remote.git");
    await git("clone", "--bare", repo, remote);
    await git("remote", "add", "origin", remote);
    return remote;
  }
  async function feature() {
    const { path } = await service.createWorktree(repo, "feature");
    await writeFile(join(path, "feature.txt"), "feature\n");
    await commit(path, "feature");
    const tree = (await service.listWorktrees(repo)).find((tree) => tree.path === path);
    if (!tree) throw new Error("Missing fixture");
    return tree;
  }
  it.each([
    "merged",
    "unmerged",
    "squash",
    "unpushed",
    "dirty",
    "untracked",
    "fetch-failed",
    "no-remote",
    "detached",
    "replaced",
    "main",
    "missing-upstream",
    "moved-tip",
    "staged",
  ])("auto-removal checks %s conservatively using real Git", async (mode) => {
    const tree = await feature();
    const identity = await service.removalIdentity(repo, tree.path);
    if (!["unmerged", "squash", "unpushed", "no-remote"].includes(mode)) {
      await git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "merge",
        "--no-ff",
        "feature",
        "-m",
        "merge",
      );
    }
    if (mode === "squash") {
      await git("merge", "--squash", "feature");
      await commit(repo, "squash");
    }
    if (mode !== "no-remote") await remote();
    if (mode === "unpushed") {
      // The tip is on the fetched default, but ahead of its configured upstream.
      await git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "merge",
        "feature",
        "-m",
        "merge",
      );
      await git("push", "origin", "main");
      await git("fetch", "origin");
      await execute(
        ["update-ref", "refs/heads/feature", (await git("rev-parse", "HEAD~1")).trim()],
        { cwd: join(temporary, "remote.git") },
      );
      await git("fetch", "origin");
      await execute(["branch", "--set-upstream-to=origin/feature"], { cwd: tree.path });
    }
    if (mode === "missing-upstream") {
      await git("config", "branch.feature.remote", "origin");
      await git("config", "branch.feature.merge", "refs/heads/missing");
    }
    if (mode === "dirty") await writeFile(join(tree.path, "feature.txt"), "changed");
    if (mode === "staged") {
      await writeFile(join(tree.path, "feature.txt"), "staged change");
      await execute(["add", "."], { cwd: tree.path });
    }
    if (mode === "moved-tip")
      vi.spyOn(service, "changes").mockImplementationOnce(async () => {
        await execute(
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "moved",
          ],
          { cwd: tree.path },
        );
        return "";
      });
    if (mode === "untracked") await writeFile(join(tree.path, "untracked.txt"), "new");
    if (mode === "fetch-failed")
      await git("remote", "set-url", "origin", join(temporary, "absent.git"));
    if (mode === "detached") await execute(["checkout", "--detach"], { cwd: tree.path });
    expect(
      await service.canAutoRemove(
        repo,
        mode === "main" ? repo : tree.path,
        mode === "replaced" ? "wrong" : identity,
      ),
    ).toBe(mode === "merged");
  });

  it.each(["merge", "squash", "rebase", "unmerged", "reverted"])(
    "detects %s content using real Git",
    async (mode) => {
      const tree = await feature();
      await writeFile(join(repo, "other.txt"), "default change\n");
      await commit(repo, "default change");
      if (mode === "merge")
        await git(
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "merge",
          "--no-ff",
          "feature",
          "-m",
          "merge",
        );
      if (mode === "squash" || mode === "reverted") {
        await git(
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "merge",
          "--squash",
          "feature",
        );
        await commit(repo, "squash");
        if (mode === "reverted")
          await git(
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "revert",
            "--no-edit",
            "HEAD",
          );
      }
      if (mode === "rebase")
        await git(
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "cherry-pick",
          "feature",
        );
      await remote();
      const base = await service.mergedDefault(repo, true);
      expect(await service.mergedCommit(repo, tree, base)).toBe(
        mode !== "unmerged" && mode !== "reverted",
      );
      expect(await service.mergedCommit(repo, { ...tree, branch: null }, base)).toBe(
        mode === "merge" || mode === "squash" || mode === "rebase",
      );
      await expect(service.mergedCommit(repo, tree, "--bad")).rejects.toThrow("Invalid commit");
      await expect(service.mergedCommit(repo, { ...tree, head: "bad" }, base)).rejects.toThrow(
        "Invalid commit",
      );
    },
  );
  it.each([
    "merge",
    "squash",
    "rebase",
    "head mismatch",
    "missing default",
    "missing object",
    "dirty",
    "hostile",
    "fork",
    "missing merge",
    "closed",
    "unavailable",
  ])("verifies PR %s hints locally after default changes the same lines", async (mode) => {
    const lookup = vi.fn((args: readonly string[]) =>
      Promise.resolve(
        JSON.stringify(args[1] === "list" ? [response] : args[1] === "checks" ? [] : response),
      ),
    );
    service = new WorktreeService(root, () =>
      forgeProvider("https://github.com/test/repo", lookup),
    );
    await service.addRepository(repo);
    const tree = await feature();
    await writeFile(join(repo, "other.txt"), "default change\n");
    await commit(repo, "default change");
    if (mode === "merge") {
      await git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "merge",
        "--no-ff",
        "feature",
        "-m",
        "merge",
      );
    } else if (mode === "rebase") {
      await git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "cherry-pick",
        "feature",
      );
    } else {
      await git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "merge",
        "--squash",
        "feature",
      );
      await commit(repo, "squashed feature");
    }
    const mergeCommit = (await git("rev-parse", "HEAD")).trim();
    if (mode === "missing default") await git("reset", "--hard", "HEAD~1");
    await writeFile(join(repo, "feature.txt"), "later default edit\n");
    await commit(repo, "later edit");
    await remote();
    const response = {
      number: 579,
      headRefName: "feature",
      headRefOid: tree.head,
      state: mode === "closed" ? "CLOSED" : "MERGED",
      isCrossRepository: mode === "fork",
      headRepositoryOwner: { login: "test" },
      mergeCommit:
        mode === "missing merge"
          ? null
          : {
              oid:
                mode === "hostile"
                  ? "--help"
                  : mode === "missing object"
                    ? "f".repeat(40)
                    : mergeCommit,
            },
    };
    if (mode === "unavailable") lookup.mockRejectedValue(new Error("offline"));
    if (mode === "head mismatch") {
      await writeFile(join(tree.path, "extra.txt"), "local commit");
      await commit(tree.path, "after PR");
    }
    if (mode === "dirty") await writeFile(join(tree.path, "untracked.txt"), "dirty");
    const current = (await service.listWorktrees(repo)).find((item) => item.path === tree.path);
    if (!current) throw new Error("Missing fixture");
    const base = await service.mergedDefault(repo, true);
    // Content alone cannot authorize these squash/rebase cases after the later edit.
    expect(await service.mergedCommit(repo, current, base)).toBe(
      ["merge", "squash", "rebase"].includes(mode),
    );
    expect(
      await service.canAutoRemove(repo, tree.path, await service.removalIdentity(repo, tree.path)),
    ).toBe(["merge", "squash", "rebase"].includes(mode));
    expect(lookup).toHaveBeenCalled();
  });
  it("rejects conflicts and deletes only an unchanged, unchecked-out local branch", async () => {
    const tree = await feature();
    await writeFile(join(repo, "feature.txt"), "different\n");
    await commit(repo, "conflict");
    await remote();
    expect(await service.mergedCommit(repo, tree, await service.mergedDefault(repo))).toBe(false);
    if (!tree.head) throw new Error("Missing head");
    await expect(service.deleteMergedBranch(repo, "feature", tree.head)).rejects.toThrow(
      "checked out",
    );
    await service.removeWorktree(repo, tree.path);
    await git("branch", "-f", "feature", "main");
    await expect(service.deleteMergedBranch(repo, "feature", tree.head)).rejects.toThrow();
    expect(await git("branch", "--list", "feature")).toContain("feature");
    await git("branch", "-f", "feature", tree.head);
    await service.deleteMergedBranch(repo, "feature", tree.head);
    expect(await git("branch", "--list", "feature")).toBe("");
    await expect(service.deleteMergedBranch(repo, "feature", "--bad")).rejects.toThrow(
      "Invalid commit",
    );
    const main = (await git("rev-parse", "main")).trim();
    await git("symbolic-ref", "refs/heads/alias", "refs/heads/main");
    await service.deleteMergedBranch(repo, "alias", main);
    expect((await git("rev-parse", "main")).trim()).toBe(main);
  });
  it("fetches the advertised default, shares inventory fetches and refuses failed refreshes", async () => {
    expect(service.mergedFetchTime(repo)).toBeUndefined();
    await expect(service.mergedDefault(repo)).rejects.toThrow("remote");
    const upstream = await remote();
    const base = await service.mergedDefault(repo, true);
    expect(service.mergedFetchTime(repo)).toEqual(expect.any(Number));
    await git("remote", "set-url", "origin", join(temporary, "missing"));
    expect(await service.mergedDefault(repo)).toBe(base);
    await expect(service.mergedDefault(repo, true)).rejects.toThrow("fetch failed");
    expect(service.mergedFetchTime(repo)).toBeUndefined();
    await git("remote", "set-url", "origin", upstream);
    await git("branch", "next");
    await git("push", "origin", "next");
    await execute(["symbolic-ref", "HEAD", "refs/heads/next"], { cwd: upstream });
    expect(await service.mergedDefault(repo, true)).toBe(base);
    await git("remote", "rename", "origin", "upstream");
    expect(await service.mergedDefault(repo, true)).toBe(base);
    await git("remote", "add", "second", upstream);
    await expect(service.mergedDefault(repo, true)).rejects.toThrow("unambiguous");
    await git("remote", "remove", "second");
    await execute(["symbolic-ref", "HEAD", "refs/heads/missing"], { cwd: upstream });
    await expect(service.mergedDefault(repo, true)).rejects.toThrow("default branch");
  });
});

it.each(["untracked", "commit", "forge"])(
  "merged cleanup preserves a real worktree gaining %s after confirmation",
  async (change) => {
    let merged = true;
    let prHead = "";
    let mergeCommit = "";
    if (change === "forge") {
      service = new WorktreeService(root, () => ({
        lookup: () =>
          Promise.resolve({
            number: 579,
            headSha: prHead,
            mergeCommit,
            state: merged ? "MERGED" : "CLOSED",
            requiredChecks: "none",
          }),
      }));
      await service.addRepository(repo);
    }
    const tree = (await service.createWorktree(repo, "changed")).path;
    if (change === "forge") {
      const commit = async (cwd: string) => {
        await execute(["add", "."], { cwd });
        await execute(
          ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"],
          { cwd },
        );
      };
      await writeFile(join(tree, "feature.txt"), "feature");
      await commit(tree);
      prHead = (await execute(["rev-parse", "HEAD"], { cwd: tree })).stdout.trim();
      await writeFile(join(repo, "default.txt"), "diverge before squash");
      await commit(repo);
      await git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "merge",
        "--squash",
        "changed",
      );
      await commit(repo);
      mergeCommit = (await git("rev-parse", "HEAD")).trim();
      await writeFile(join(repo, "feature.txt"), "later edit");
      await commit(repo);
    }
    const removed = (await service.createWorktree(repo, "safe")).path;
    const upstream = join(temporary, "remote.git");
    await git("clone", "--bare", repo, upstream);
    await git("remote", "add", "origin", upstream);
    const workspace = new Workspace({
      worktrees: service,
      terminals: {
        create: () => Promise.reject(new Error("No launch expected")),
        kill: () => Promise.resolve(),
        stop: () => Promise.resolve(true),
        tail: () => Promise.resolve([]),
      },
      verdicts: {
        forget: vi.fn(),
        classify: () => Promise.reject(new Error("No verdict expected")),
        commit: () => Promise.resolve(),
        recordAction: () => Promise.resolve(),
      },
      receiver: () => Promise.reject(new Error("No hooks expected")),
      onState: () => {},
    });
    try {
      await expect(
        workspace.sidebarCommand(
          { kind: "delete-merged-worktrees", repository: repo },
          async (request) => {
            if (request.kind !== "merged-worktrees" || !request.feed)
              throw new Error("Missing cleanup");
            await vi.waitFor(() => {
              expect(request.feed?.current().stage).toBe("ready");
            });
            if (change === "forge") merged = false;
            else await writeFile(join(tree, "new.txt"), "must survive");
            if (change === "commit") {
              await execute(["add", "."], { cwd: tree });
              await execute(
                [
                  "-c",
                  "user.name=Test",
                  "-c",
                  "user.email=test@example.com",
                  "commit",
                  "-m",
                  "new work",
                ],
                { cwd: tree },
              );
            }
            return true;
          },
        ),
      ).resolves.toBeUndefined();
      expect(
        await readFile(join(tree, change === "forge" ? "feature.txt" : "new.txt"), "utf8"),
      ).toBe(change === "forge" ? "feature" : "must survive");
      expect(await git("branch", "--list", "changed")).toContain("changed");
      await expect(realpath(removed)).rejects.toThrow();
      expect(await git("branch", "--list", "safe")).toBe("");
    } finally {
      await workspace.dispose();
    }
  },
);

it("status inspection never refreshes the index during concurrent cleanup", async () => {
  const { path } = await service.createWorktree(repo, "status-read");
  const tracked = join(path, "tracked.txt");
  await writeFile(tracked, "unchanged content");
  await execute(["add", "."], { cwd: path });
  await execute(
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "tracked"],
    { cwd: path },
  );
  const { stdout } = await execute(["rev-parse", "--path-format=absolute", "--git-path", "index"], {
    cwd: path,
  });
  const index = stdout.trim();
  const before = await readFile(index);
  const later = new Date(Date.now() + 2000);
  await utimes(tracked, later, later);
  expect(await service.changes(repo, path)).toBe("");
  const identity = await service.removalIdentity(repo, path);
  expect(await service.changes(repo, path, identity)).toBe("");
  expect(await readFile(index)).toEqual(before);
  // Establish that ordinary status would write the stale stat cache in this fixture.
  await execute(["status", "--porcelain=v1"], { cwd: path });
  expect(await readFile(index)).not.toEqual(before);
});

it.each(["detached", "untracked", "unpushed", "tracked", "external"])(
  "group cleanup handles %s with real repositories without changing explicit removal policy",
  async (mode) => {
    const path = (await service.createWorktree(repo, "group-cleanup")).path;
    const other = join(root, "review-second");
    if (mode === "detached") {
      await execute(["checkout", "--detach"], { cwd: path });
      await git("worktree", "add", "--detach", other, "HEAD");
    }
    const upstream = join(temporary, "remote.git");
    await git("clone", "--bare", repo, upstream);
    await git("remote", "add", "origin", upstream);
    if (mode === "untracked" || mode === "unpushed")
      await writeFile(join(path, "screenshots.png"), "evidence");
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
          "unpushed",
        ],
        { cwd: path },
      );
    if (mode === "tracked") {
      await writeFile(join(path, "staged.txt"), "keep");
      await execute(["add", "."], { cwd: path });
    }
    let target = path;
    if (mode === "external") {
      target = join(temporary, "external-review");
      await git("worktree", "add", "--detach", target, "HEAD");
      await service.removeWorktree(repo, path);
    }
    const workspace = new Workspace({
      worktrees: service,
      terminals: {
        create: () => Promise.reject(new Error("No launch")),
        stop: () => Promise.resolve(true),
        kill: () => Promise.resolve(),
        tail: () => Promise.resolve([]),
      },
      verdicts: {
        forget: vi.fn(),
        classify: () => Promise.reject(new Error("No verdict")),
        commit: () => Promise.resolve(),
        recordAction: () => Promise.resolve(),
      },
      receiver: () => Promise.reject(new Error("No hooks")),
      onState: () => {},
    });
    try {
      await workspace.sidebarCommand(
        { kind: "delete-merged-worktrees", repository: repo },
        async (request) => {
          if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing feed");
          await vi.waitFor(() => {
            expect(request.feed?.current().stage).toBe("ready");
          });
          const items = request.feed.current().progress.items;
          if (mode === "untracked")
            expect(items.find((item) => item.branch === "group-cleanup")?.changes).toBe(
              "?? screenshots.png",
            );
          return true;
        },
      );
      if (mode === "detached" || mode === "untracked") {
        await expect(realpath(target)).rejects.toThrow();
        if (mode === "detached") await expect(realpath(other)).rejects.toThrow();
      } else expect(await realpath(target)).toBe(target);
    } finally {
      await workspace.dispose();
    }
  },
);

function cleanupWorkspace(extra: Partial<WorkspaceDependencies> = {}): Workspace {
  return new Workspace({
    worktrees: service,
    terminals: {
      create: () => Promise.reject(new Error("No launch expected")),
      kill: () => Promise.resolve(),
      stop: () => Promise.resolve(true),
      tail: () => Promise.resolve([]),
    },
    verdicts: {
      forget: vi.fn(),
      classify: () => Promise.reject(new Error("No verdict expected")),
      commit: () => Promise.resolve(),
      recordAction: () => Promise.resolve(),
    },
    receiver: () => Promise.reject(new Error("No hooks expected")),
    onState: () => {},
    ...extra,
  });
}

it.each(["tracked edit", "commit", "untracked set"])(
  "merged cleanup preserves a real worktree gaining %s during preview shutdown",
  async (change) => {
    await writeFile(join(repo, "tracked.txt"), "original");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "tracked",
    );
    const { path } = await service.createWorktree(repo, "preview-race");
    await git("clone", "--bare", repo, join(temporary, "remote.git"));
    await git("remote", "add", "origin", join(temporary, "remote.git"));
    await writeFile(join(path, "approved.txt"), "approved untracked");
    const prepare = vi.fn(async () => {
      if (change === "tracked edit")
        await writeFile(join(path, "tracked.txt"), "saved during shutdown");
      else if (change === "untracked set") await writeFile(join(path, "new.txt"), "new untracked");
      else
        await execute(
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "new work during shutdown",
          ],
          { cwd: path },
        );
      return () => {};
    });
    const workspace = cleanupWorkspace({ prepareWorktreeRemoval: prepare });
    try {
      await workspace.sidebarCommand(
        { kind: "delete-merged-worktrees", repository: repo },
        async (request) => {
          if (request.kind !== "merged-worktrees" || !request.feed)
            throw new Error("Missing cleanup");
          await vi.waitFor(() => {
            expect(request.feed?.current().stage).toBe("ready");
          });
          return true;
        },
      );
      expect(prepare).toHaveBeenCalledOnce();
      expect(await readFile(join(path, "approved.txt"), "utf8")).toBe("approved untracked");
      if (change === "tracked edit")
        expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("saved during shutdown");
      if (change === "untracked set")
        expect(await readFile(join(path, "new.txt"), "utf8")).toBe("new untracked");
      if (change === "commit")
        expect((await execute(["log", "-1", "--format=%s"], { cwd: path })).stdout.trim()).toBe(
          "new work during shutdown",
        );
    } finally {
      await workspace.dispose();
    }
  },
);

it(
  "detached group cleanup cannot release a later explicit removal reservation",
  usingFixture(async () => {
    const { path } = await service.createWorktree(repo, "detached-a");
    await execute(["checkout", "--detach"], { cwd: path });
    await git("clone", "--bare", repo, join(temporary, "remote.git"));
    await git("remote", "add", "origin", join(temporary, "remote.git"));
    const branchesEntered = Promise.withResolvers<undefined>();
    const finishBranches = Promise.withResolvers<undefined>();
    const confirmationEntered = Promise.withResolvers<undefined>();
    const finishConfirmation = Promise.withResolvers<boolean>();
    const deleteBranches = service.deleteMergedBranches.bind(service);
    vi.spyOn(service, "deleteMergedBranches").mockImplementation(async (...args) => {
      branchesEntered.resolve(undefined);
      await finishBranches.promise;
      return deleteBranches(...args);
    });
    const workspace = cleanupWorkspace();
    const group = workspace.sidebarCommand(
      { kind: "delete-merged-worktrees", repository: repo },
      async (request) => {
        if (request.kind !== "merged-worktrees" || !request.feed)
          throw new Error("Missing cleanup");
        await vi.waitFor(() => {
          expect(request.feed?.current().stage).toBe("ready");
        });
        return true;
      },
    );
    let first: Promise<void> | undefined;
    try {
      await branchesEntered.promise;
      await expect(realpath(path)).rejects.toThrow();
      const other = join(root, "detached-b");
      await git("worktree", "add", "--detach", other, "HEAD");
      const command = { kind: "remove-worktree" as const, repository: repo, worktree: other };
      first = workspace.sidebarCommand(command, () => {
        confirmationEntered.resolve(undefined);
        return finishConfirmation.promise;
      });
      await confirmationEntered.promise;
      finishBranches.resolve(undefined);
      await group;
      const secondConfirmation = vi.fn(() => Promise.resolve(false));
      await expect(workspace.sidebarCommand(command, secondConfirmation)).rejects.toThrow(
        "This worktree is busy",
      );
      expect(secondConfirmation).not.toHaveBeenCalled();
    } finally {
      finishBranches.resolve(undefined);
      finishConfirmation.resolve(false);
      await Promise.allSettled([group, ...(first ? [first] : [])]);
      await workspace.dispose();
    }
  }),
);

it.each([
  ["assume-unchanged", "eligibility"],
  ["skip-worktree", "eligibility"],
  ["sparse", "eligibility"],
  ["assume-unchanged", "preview shutdown"],
  ["skip-worktree", "preview shutdown"],
  ["sparse", "preview shutdown"],
])("group cleanup preserves hidden tracked edits with %s set during %s", async (mode, phase) => {
  await writeFile(join(repo, "tracked.txt"), "original");
  await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "tracked");
  const { path } = await service.createWorktree(repo, "hidden-edit");
  await git("clone", "--bare", repo, join(temporary, "remote.git"));
  await git("remote", "add", "origin", join(temporary, "remote.git"));
  await writeFile(join(path, "screenshot.png"), "untracked evidence");
  const hide = async () => {
    if (mode === "sparse") {
      // Materialize every file, so sparse config is independent of skip-worktree.
      await execute(["sparse-checkout", "init", "--no-cone"], { cwd: path });
      await execute(["sparse-checkout", "set", "--no-cone", "/*"], { cwd: path });
    }
    await execute(
      [
        "update-index",
        mode === "skip-worktree" ? "--skip-worktree" : "--assume-unchanged",
        "tracked.txt",
      ],
      { cwd: path },
    );
    await writeFile(join(path, "tracked.txt"), "hidden edit must survive");
    expect(
      (
        await execute(
          ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
          { cwd: path },
        )
      ).stdout,
    ).toBe("?? screenshot.png\0");
  };
  if (phase === "eligibility") await hide();
  const prepare = vi.fn(async () => {
    if (phase === "preview shutdown") await hide();
    return () => {};
  });
  const workspace = cleanupWorkspace({ prepareWorktreeRemoval: prepare });
  try {
    await workspace.sidebarCommand(
      { kind: "delete-merged-worktrees", repository: repo },
      async (request) => {
        if (request.kind !== "merged-worktrees" || !request.feed)
          throw new Error("Missing cleanup");
        await vi.waitFor(() => {
          expect(request.feed?.current().stage).toBe("ready");
        });
        return true;
      },
    );
    expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe("hidden edit must survive");
    expect(await readFile(join(path, "screenshot.png"), "utf8")).toBe("untracked evidence");
    if (phase === "eligibility") expect(prepare).not.toHaveBeenCalled();
    else expect(prepare).toHaveBeenCalledOnce();
    expect(await git("branch", "--list", "hidden-edit")).toContain("hidden-edit");
  } finally {
    await workspace.dispose();
  }
});

it.each(["ignored", "submodule", "private ref", "ignorecase", "rebase"])(
  "group cleanup accounts for real Git %s state before approval and deletion",
  async (mode) => {
    await writeFile(join(repo, "tracked.txt"), "original");
    await writeFile(join(repo, ".gitignore"), ".env\n");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "tracked",
    );
    const { path } = await service.createWorktree(repo, "review-state");
    if (mode === "submodule") {
      const source = join(temporary, "module");
      await execute(["clone", repo, source], { cwd: repo });
      await execute(["-c", "protocol.file.allow=always", "submodule", "add", source, "module"], {
        cwd: path,
      });
      await execute(
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-am", "module"],
        { cwd: path },
      );
      await execute(["config", "diff.ignoreSubmodules", "all"], { cwd: path });
      await writeFile(join(path, "module", "tracked.txt"), "private module edit");
      await git("merge", "--ff-only", "review-state");
    }
    await git("clone", "--bare", repo, join(temporary, "remote.git"));
    await git("remote", "add", "origin", join(temporary, "remote.git"));
    await writeFile(join(path, "screenshot.png"), "untracked evidence");
    if (mode === "ignored") await writeFile(join(path, ".env"), "secret evidence");
    if (mode === "private ref") {
      const saved = (
        await execute(
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit-tree",
            "HEAD^{tree}",
            "-m",
            "private work",
          ],
          { cwd: path },
        )
      ).stdout.trim();
      await execute(["update-ref", "refs/worktree/saved", saved], { cwd: path });
    }
    if (mode === "ignorecase") {
      await execute(["config", "core.ignorecase", "true"], { cwd: path });
      await writeFile(join(path, "TRACKED.txt"), "case hidden edit");
    }
    if (mode === "rebase") {
      // A genuine paused interactive rebase, with an otherwise clean worktree.
      await execute(
        ["-c", "sequence.editor=true", "rebase", "--interactive", "--exec", "false", "HEAD~1"],
        { cwd: path },
      ).catch(() => {});
    }
    const workspace = cleanupWorkspace();
    try {
      await workspace.sidebarCommand(
        { kind: "delete-merged-worktrees", repository: repo },
        async (request) => {
          if (request.kind !== "merged-worktrees" || !request.feed)
            throw new Error("Missing cleanup");
          await vi.waitFor(() => {
            expect(request.feed?.current().stage).toBe("ready");
          });
          const item = request.feed
            .current()
            .progress.items.find((item) => item.branch === "review-state");
          if (mode === "ignored") {
            expect(item?.changes).toContain("!! .env");
            return false;
          }
          return true;
        },
      );
      expect(await readFile(join(path, "screenshot.png"), "utf8")).toBe("untracked evidence");
      if (mode === "ignored")
        expect(await readFile(join(path, ".env"), "utf8")).toBe("secret evidence");
      if (mode === "submodule")
        expect(await readFile(join(path, "module", "tracked.txt"), "utf8")).toBe(
          "private module edit",
        );
      if (mode === "private ref")
        expect(
          (await execute(["show-ref", "refs/worktree/saved"], { cwd: path })).stdout,
        ).toContain("refs/worktree/saved");
      if (mode === "ignorecase")
        expect(await readFile(join(path, "TRACKED.txt"), "utf8")).toBe("case hidden edit");
    } finally {
      await workspace.dispose();
    }
  },
);

it.each(["ignored file", "private ref", ".gitmodules"])(
  "final cleanup snapshot refuses a new %s after preview shutdown",
  async (mode) => {
    await writeFile(join(repo, ".gitignore"), ".env\n");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "ignore",
    );
    const { path } = await service.createWorktree(repo, "late-state");
    await git("clone", "--bare", repo, join(temporary, "remote.git"));
    await git("remote", "add", "origin", join(temporary, "remote.git"));
    await writeFile(join(path, "screenshot.png"), "approved evidence");
    const prepare = vi.fn(async () => {
      if (mode === "private ref")
        await execute(["update-ref", "refs/worktree/saved", "HEAD"], { cwd: path });
      else
        await writeFile(
          join(path, mode === "ignored file" ? ".env" : ".gitmodules"),
          "new undisclosed data",
        );
      return () => {};
    });
    const workspace = cleanupWorkspace({ prepareWorktreeRemoval: prepare });
    try {
      await workspace.sidebarCommand(
        { kind: "delete-merged-worktrees", repository: repo },
        async (request) => {
          if (request.kind !== "merged-worktrees" || !request.feed)
            throw new Error("Missing cleanup");
          await vi.waitFor(() => {
            expect(request.feed?.current().stage).toBe("ready");
          });
          return true;
        },
      );
      expect(prepare).toHaveBeenCalledOnce();
      expect(await readFile(join(path, "screenshot.png"), "utf8")).toBe("approved evidence");
    } finally {
      await workspace.dispose();
    }
  },
);

it("ignored-only leftovers are reviewed and removed without force", async () => {
  await writeFile(join(repo, ".gitignore"), ".env\ncache/\n");
  await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "ignore");
  const { path } = await service.createWorktree(repo, "ignored-only");
  await git("clone", "--bare", repo, join(temporary, "remote.git"));
  await git("remote", "add", "origin", join(temporary, "remote.git"));
  await writeFile(join(path, ".env"), "secret");
  await mkdir(join(path, "cache"));
  await writeFile(join(path, "cache", "entry"), "ignored directory");
  const remove = vi.spyOn(service, "removeWorktree");
  const workspace = cleanupWorkspace();
  try {
    await workspace.sidebarCommand(
      { kind: "delete-merged-worktrees", repository: repo },
      async (request) => {
        if (request.kind !== "merged-worktrees" || !request.feed)
          throw new Error("Missing cleanup");
        await vi.waitFor(() => {
          expect(request.feed?.current().stage).toBe("ready");
        });
        expect(
          request.feed.current().progress.items.find((item) => item.branch === "ignored-only")
            ?.changes,
        ).toBe("!! .env\0!! cache/");
        return true;
      },
    );
    expect(remove).toHaveBeenCalledWith(
      repo,
      path,
      false,
      expect.any(String),
      expect.any(Function),
    );
    await expect(realpath(path)).rejects.toThrow();
  } finally {
    await workspace.dispose();
  }
});

it("preserves a tracked save during the final cleanup snapshot identity await", async () => {
  await writeFile(join(repo, "tracked.txt"), "original");
  await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "tracked");
  const { path } = await service.createWorktree(repo, "final-snapshot-race");
  await git("clone", "--bare", repo, join(temporary, "remote.git"));
  await git("remote", "add", "origin", join(temporary, "remote.git"));
  await writeFile(join(path, "approved.png"), "approved evidence");
  let afterPreview = false;
  let snapshot = 0;
  let saved = false;
  const status = service.cleanupStatus.bind(service);
  vi.spyOn(service, "cleanupStatus").mockImplementation(async (...args) => {
    if (afterPreview) snapshot++;
    return status(...args);
  });
  const identity = service.removalIdentity.bind(service);
  vi.spyOn(service, "removalIdentity").mockImplementation(async (...args) => {
    const result = await identity(...args);
    // The first post-preview snapshot belongs to merge revalidation. The
    // second is the final approved snapshot, adjacent to forced Git removal.
    if (snapshot === 2 && !saved) {
      saved = true;
      await writeFile(join(path, "tracked.txt"), "saved during final identity check");
    }
    return result;
  });
  const workspace = cleanupWorkspace({
    prepareWorktreeRemoval: () => {
      afterPreview = true;
      return Promise.resolve(() => {});
    },
  });
  try {
    await workspace.sidebarCommand(
      { kind: "delete-merged-worktrees", repository: repo },
      async (request) => {
        if (request.kind !== "merged-worktrees" || !request.feed)
          throw new Error("Missing cleanup");
        await vi.waitFor(() => {
          expect(request.feed?.current().stage).toBe("ready");
        });
        return true;
      },
    );
    expect(saved).toBe(true);
    expect(await readFile(join(path, "tracked.txt"), "utf8")).toBe(
      "saved during final identity check",
    );
    expect(await readFile(join(path, "approved.png"), "utf8")).toBe("approved evidence");
  } finally {
    await workspace.dispose();
  }
});
