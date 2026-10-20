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

describe("repository discovery", () => {
  it("canonicalizes paths, deduplicates subdirectories, and returns immutable descriptors", async () => {
    const sub = join(repo, "sub");
    await mkdir(sub);
    const repository = await service.addRepository(sub);
    expect(repository).toEqual({ path: repo, name: "repo with spaces" });
    expect(Object.isFrozen(repository)).toBe(true);
    expect(service.listRepositories()).toEqual([repository]);
    expect(await service.listWorktrees(repo)).toEqual([
      expect.objectContaining({
        path: repo,
        branch: "main",
        managed: false,
        locked: false,
        prunable: false,
      }),
    ]);
  });
  it("rejects non-repositories, bare repositories, absent paths and invalid paths", async () => {
    await expect(service.addRepository(temporary)).rejects.toThrow();
    const bare = join(temporary, "bare");
    await git("init", "--bare", bare);
    await expect(service.addRepository(bare)).rejects.toThrow("must be a Git work tree");
    await expect(service.addRepository(join(temporary, "missing"))).rejects.toThrow();
    await expect(service.addRepository("")).rejects.toThrow("Invalid path");
    expect(() => new WorktreeService("\0")).toThrow("Invalid path");
    expect(new WorktreeService().listRepositories()).toEqual([]);
  });
  it("never registers a repository holding the Foom config folder", async () => {
    const config = join(repo, "nested", "config");
    await mkdir(config, { recursive: true });
    const fresh = new WorktreeService(root);
    await fresh.protect(config);
    await expect(fresh.addRepository(config)).rejects.toThrow("Foom config cannot be inside");
    await expect(fresh.addRepository(repo)).rejects.toThrow("Foom config cannot be inside");
    // A subfolder resolves to the repository top level, which holds the folder.
    await mkdir(join(repo, "other"));
    await expect(fresh.addRepository(join(repo, "other"))).rejects.toThrow(
      "Foom config cannot be inside",
    );
    expect(fresh.listRepositories()).toEqual([]);
    await expect(fresh.protect("")).rejects.toThrow("Invalid path");
    // An unresolved protected path still compares by its absolute form.
    await fresh.protect(join(temporary, "missing", "config"));
    expect(await service.managesPath(config)).toBe(true);
    expect(await service.managesPath(repo)).toBe(true);
    expect(await service.managesPath(join(temporary, "elsewhere"))).toBe(false);
  });
  it("drops a saved repository that holds the Foom config folder when loading", async () => {
    const userData = join(temporary, "user-data");
    await mkdir(userData);
    await writeFile(
      join(userData, "worktrees.json"),
      JSON.stringify({ version: 1, repositories: [repo], managed: [] }),
    );
    expect((await WorktreeService.open(userData, root)).listRepositories()).toHaveLength(1);
    const protectedService = await WorktreeService.open(userData, root, [join(repo, ".foom")]);
    expect(protectedService.listRepositories()).toEqual([]);
  });
  it("ignores inherited Git repository selectors", async () => {
    vi.stubEnv("GIT_DIR", join(temporary, "hostile"));
    expect(await service.addRepository(repo)).toEqual({ path: repo, name: "repo with spaces" });
  });
  it("requires registration for every operation", async () => {
    await expect(service.listWorktrees(temporary)).rejects.toThrow("has not been added");
    await expect(service.createWorktree(temporary, "feature")).rejects.toThrow(
      "has not been added",
    );
    await expect(service.removeWorktree(temporary, repo)).rejects.toThrow("has not been added");
  });
});

describe("forgetting repositories", () => {
  it("removes an unused repository, persistently", async () => {
    const service = await WorktreeService.open(join(temporary, "user-data"), root);
    await service.addRepository(repo);
    await service.removeRepository(repo);
    expect(service.listRepositories()).toEqual([]);
    const reopened = await WorktreeService.open(join(temporary, "user-data"), root);
    expect(reopened.listRepositories()).toEqual([]);
    await expect(service.removeRepository(repo)).rejects.toThrow("has not been added");
  });
  it("forgets repositories while preserving their worktrees and allowing re-registration", async () => {
    const first = (await service.createWorktree(repo, "one")).path;
    await service.removeRepository(repo);
    expect(service.listRepositories()).toEqual([]);
    expect(await realpath(first)).toBe(first);
    await service.addRepository(repo);
    await service.removeWorktree(repo, first);
    await expect(realpath(first)).rejects.toThrow();
  });
});

describe("creation and listing", () => {
  it("supports linked worktrees belonging to a bare repository", async () => {
    const bare = join(temporary, "bare.git");
    const linked = join(temporary, "linked");
    await git("clone", "--bare", repo, bare);
    await execute(["worktree", "add", linked, "main"], { cwd: bare });
    await service.addRepository(linked);
    expect(await service.listWorktrees(linked)).toContainEqual(
      expect.objectContaining({ path: bare, bare: true, head: null, managed: false }),
    );
    const { path } = await service.createWorktree(linked, "from-bare");
    await service.removeWorktree(linked, path);
  });
  it.skipIf(process.platform === "win32")(
    "preserves unusual path characters in porcelain output",
    async () => {
      const unusual = join(temporary, "repo\nwith\ttabs");
      await rename(repo, unusual);
      const added = await service.addRepository(unusual);
      expect(added.path).toBe(unusual);
      const { path } = await service.createWorktree(unusual, "feature");
      expect(await service.listWorktrees(unusual)).toContainEqual(
        expect.objectContaining({ path, managed: true }),
      );
      await service.removeWorktree(unusual, path);
    },
  );

  it("creates nested branches under the configured root and removes owned trees", async () => {
    const { path } = await service.createWorktree(repo, "feature/one");
    expect(path).toBe(join(root, "repo with spaces", "feature", "one"));
    expect(await service.listWorktrees(repo)).toContainEqual(
      expect.objectContaining({ path, branch: "feature/one", managed: true }),
    );
    await service.removeWorktree(repo, path);
    expect(await service.listWorktrees(repo)).toHaveLength(1);
    await expect(service.removeWorktree(repo, path, true)).rejects.toThrow("worktree-missing");
    expect(await git("branch", "--list", "feature/one")).toContain("feature/one");
  });
  it("starts new branches from HEAD and reports what it did", async () => {
    await git("branch", "existing", "main");
    const created = await service.createWorktree(repo, "fresh");
    expect(created.outcome).toBe("new");
    expect(await git("rev-parse", "fresh")).toBe(await git("rev-parse", "HEAD"));
    expect(await git("config", "--get-regexp", "^branch\\.fresh\\.").catch(() => "")).toBe("");
    await expect(service.createWorktree(repo, "existing")).resolves.toMatchObject({
      outcome: "existing",
    });
  });
  it("checks out origin-only branches tracking the remote, and lists local refs only", async () => {
    const upstream = join(temporary, "upstream.git");
    await execute(["init", "--bare", upstream], { cwd: temporary });
    await git("remote", "add", "origin", upstream);
    await git("push", "origin", "main");
    await git("checkout", "-b", "remote-only");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "Remote work",
    );
    await git("push", "origin", "remote-only");
    await git("checkout", "main");
    await git("branch", "-D", "remote-only");
    await git("remote", "set-head", "origin", "main");
    // A local branch shaped like the remote ref must not capture the start point.
    await git("branch", "origin/remote-only", "main");
    const inventory = await service.branches(repo);
    expect(inventory).toEqual({
      head: "main",
      local: [
        { name: "main", worktree: repo },
        { name: "origin/remote-only", worktree: null },
      ],
      remote: "origin",
      remoteBranches: ["main", "remote-only"],
    });
    const { path, outcome } = await service.createWorktree(repo, "remote-only");
    expect(outcome).toBe("origin");
    expect(await git("rev-parse", "remote-only")).toBe(
      await git("rev-parse", "refs/remotes/origin/remote-only"),
    );
    expect(await git("config", "branch.remote-only.remote")).toBe("origin\n");
    expect(await git("config", "branch.remote-only.merge")).toBe("refs/heads/remote-only\n");
    expect((await service.branches(repo)).local).toContainEqual({
      name: "remote-only",
      worktree: path,
    });
    // Orchestrator children still start from HEAD, even if a remote-only name exists.
    await git("update-ref", "refs/remotes/origin/child-only", "refs/remotes/origin/remote-only");
    await expect(
      service.createWorktree(repo, "child-only", { newBranch: true }),
    ).resolves.toMatchObject({
      outcome: "new",
    });
    expect(await git("rev-parse", "child-only")).toBe(await git("rev-parse", "HEAD"));
    expect(await git("config", "--get-regexp", "^branch\\.child-only\\.").catch(() => "")).toBe("");
    // Another remote without origin is ambiguous: no remote branches are offered.
    await git("remote", "rename", "origin", "first");
    await git("remote", "add", "second", upstream);
    await expect(service.branches(repo)).resolves.toMatchObject({
      remote: null,
      remoteBranches: [],
    });
    await expect(service.createWorktree(repo, "unknown")).resolves.toMatchObject({
      outcome: "new",
    });
  });
  it("reports a detached main checkout without a head branch", async () => {
    await git("checkout", "--detach");
    await expect(service.branches(repo)).resolves.toMatchObject({ head: null, remote: null });
    await expect(service.branches(join(temporary, "missing"))).rejects.toThrow("not been added");
  });
  it("refuses an existing branch when a new one is required", async () => {
    await git("branch", "taken");
    await expect(
      service.createWorktree(repo, "taken", { location: "adjacent", newBranch: true }),
    ).rejects.toThrow("Branch already exists");
    await expect(stat(join(temporary, "repo with spaces-taken"))).rejects.toThrow();
    await expect(service.createWorktree(repo, "main", { newBranch: true })).rejects.toThrow(
      "Branch already exists",
    );
    const { path } = await service.createWorktree(repo, "fresh", { newBranch: true });
    expect(await service.listWorktrees(repo)).toContainEqual(
      expect.objectContaining({ path, branch: "fresh", managed: true }),
    );
  });
  it("supports existing branches and adjacent placement", async () => {
    await git("branch", "existing");
    const { path } = await service.createWorktree(repo, "existing", { location: "adjacent" });
    expect(path).toBe(join(temporary, "repo with spaces-existing"));
    expect(await service.listWorktrees(repo)).toContainEqual(
      expect.objectContaining({ path, branch: "existing", managed: true }),
    );
    await service.removeWorktree(repo, path);
  });
  it("lists external, detached, locked and prunable trees without adopting them", async () => {
    const external = join(temporary, "external");
    await git("worktree", "add", "--detach", external);
    await git("worktree", "lock", "--reason", "test lock", external);
    expect(await service.listWorktrees(repo)).toContainEqual(
      expect.objectContaining({ path: external, branch: null, locked: true, managed: false }),
    );
    await expect(service.removeWorktree(repo, external, true)).rejects.toThrow("worktree-locked");
    await git("worktree", "unlock", external);
    await rm(external, { recursive: true });
    expect(await service.listWorktrees(repo)).toContainEqual(
      expect.objectContaining({ path: external, prunable: true, managed: false }),
    );
  });
  it.each([
    "--upload-pack=touch owned",
    "../x",
    "with spaces",
    "",
    "-bad",
    "a\\b",
    "C:/x",
    "a\0b",
    "/absolute",
    "foo/../../escape",
    "a.lock",
    "@{-1}",
  ])("rejects hostile or invalid branch %j", async (branch) => {
    await expect(service.createWorktree(repo, branch)).rejects.toThrow();
    expect(await service.listWorktrees(repo)).toHaveLength(1);
  });
  it("rejects checkout shorthand even when Git can expand it", async () => {
    await git("checkout", "-b", "previous");
    await git("checkout", "main");
    await expect(service.createWorktree(repo, "@{-1}")).rejects.toThrow("shorthand");
  });
  it("reports a checked-out branch instead of adding it again", async () => {
    await expect(service.createWorktree(repo, "main")).resolves.toEqual({
      path: repo,
      outcome: "open",
    });
    const { path } = await service.createWorktree(repo, "elsewhere");
    await expect(service.createWorktree(repo, "elsewhere")).resolves.toEqual({
      path,
      outcome: "open",
    });
    await expect(realpath(join(root, "repo with spaces", "main"))).rejects.toThrow();
    expect(await service.listWorktrees(repo)).toHaveLength(2);
  });
  it("cleans up reservations after Git rejects a branch", async () => {
    // A ref cannot nest under an existing branch, so `git worktree add` fails.
    await expect(service.createWorktree(repo, "main/nested")).rejects.toThrow();
    await expect(realpath(join(root, "repo with spaces", "main", "nested"))).rejects.toThrow();
    expect(await service.listWorktrees(repo)).toHaveLength(1);
  });
  it("preserves existing destinations", async () => {
    const destination = join(root, "repo with spaces", "existing-dir");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "keep"), "safe");
    await expect(service.createWorktree(repo, "existing-dir")).rejects.toThrow();
    expect(await readFile(join(destination, "keep"), "utf8")).toBe("safe");
  });
  it("rejects symlinks escaping the root before creating descendant directories", async () => {
    await mkdir(root);
    await symlink(temporary, join(root, "repo with spaces"), "junction");
    await expect(service.createWorktree(repo, "new/escape")).rejects.toThrow("allowed root");
    await expect(realpath(join(temporary, "new"))).rejects.toThrow();
  });
  it("rejects redirected parents even inside the root", async () => {
    const target = join(root, "target");
    await mkdir(target, { recursive: true });
    await symlink(target, join(root, "repo with spaces"), "junction");
    await expect(service.createWorktree(repo, "feature")).rejects.toThrow(
      "parent has been redirected",
    );
  });
  it("passes valid shell metacharacters literally to Git", async () => {
    const branch = "feature;echo-owned";
    const { path } = await service.createWorktree(repo, branch);
    expect(await service.listWorktrees(repo)).toContainEqual(
      expect.objectContaining({ path, branch, managed: true }),
    );
    await service.removeWorktree(repo, path);
  });
  it("rejects a symlink at the destination", async () => {
    const destination = join(root, "repo with spaces", "escape");
    await mkdir(dirname(destination), { recursive: true });
    await symlink(temporary, destination, "junction");
    await expect(service.createWorktree(repo, "escape")).rejects.toThrow();
  });
});
