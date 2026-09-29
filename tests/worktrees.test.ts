import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeService } from "../src/worktrees";

const executeFile = promisify(execFile);
function execute(command: string, args: string[], options: { cwd: string }) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return executeFile(command, args, { ...options, env });
}
let temporary: string;
let repo: string;
let root: string;
let service: WorktreeService;
async function git(...args: string[]): Promise<string> {
  const { stdout } = await execute("git", args, { cwd: repo });
  return stdout;
}
beforeEach(async () => {
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
});
afterEach(async () => {
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

describe("creation and listing", () => {
  it("supports linked worktrees belonging to a bare repository", async () => {
    const bare = join(temporary, "bare.git");
    const linked = join(temporary, "linked");
    await git("clone", "--bare", repo, bare);
    await execute("git", ["worktree", "add", linked, "main"], { cwd: bare });
    await service.addRepository(linked);
    expect(await service.listWorktrees(linked)).toContainEqual(
      expect.objectContaining({ path: bare, bare: true, head: null, managed: false }),
    );
    const path = await service.createWorktree(linked, "from-bare");
    await service.removeWorktree(linked, path);
  });
  it.skipIf(process.platform === "win32")(
    "preserves unusual path characters in porcelain output",
    async () => {
      const unusual = join(temporary, "repo\nwith\ttabs");
      await rename(repo, unusual);
      const added = await service.addRepository(unusual);
      expect(added.path).toBe(unusual);
      const path = await service.createWorktree(unusual, "feature");
      expect(await service.listWorktrees(unusual)).toContainEqual(
        expect.objectContaining({ path, managed: true }),
      );
      await service.removeWorktree(unusual, path);
    },
  );

  it("creates nested branches under the configured root and removes owned trees", async () => {
    const path = await service.createWorktree(repo, "feature/one");
    expect(path).toBe(join(root, "repo with spaces", "feature", "one"));
    expect(await service.listWorktrees(repo)).toContainEqual(
      expect.objectContaining({ path, branch: "feature/one", managed: true }),
    );
    await service.removeWorktree(repo, path);
    expect(await service.listWorktrees(repo)).toHaveLength(1);
    await expect(service.removeWorktree(repo, path, true)).rejects.toThrow("not managed");
    expect(await git("branch", "--list", "feature/one")).toContain("feature/one");
  });
  it("supports existing branches and adjacent placement", async () => {
    await git("branch", "existing");
    const path = await service.createWorktree(repo, "existing", { location: "adjacent" });
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
    await expect(service.removeWorktree(repo, external, true)).rejects.toThrow("not managed");
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
  it("cleans up reservations after Git rejects an already checked out branch", async () => {
    await expect(service.createWorktree(repo, "main")).rejects.toThrow();
    await expect(realpath(join(root, "repo with spaces", "main"))).rejects.toThrow();
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
    const path = await service.createWorktree(repo, branch);
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

describe("safe removal", () => {
  it.each(["untracked", "tracked", "staged"])("refuses %s changes unless forced", async (kind) => {
    const path = await service.createWorktree(repo, "dirty");
    const file = join(path, "file");
    await writeFile(file, "original");
    if (kind !== "untracked") {
      await execute("git", ["add", "file"], { cwd: path });
      if (kind === "tracked") {
        await execute(
          "git",
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
  it("does not acquire ownership on restart or allow a different repository to remove a tree", async () => {
    const path = await service.createWorktree(repo, "owned");
    const fresh = new WorktreeService(root);
    await fresh.addRepository(repo);
    await expect(fresh.removeWorktree(repo, path, true)).rejects.toThrow("not managed");
    const other = join(temporary, "other");
    await mkdir(other);
    await execute("git", ["init"], { cwd: other });
    await service.addRepository(other);
    await expect(service.removeWorktree(other, path, true)).rejects.toThrow("not managed");
    await expect(service.removeWorktree(repo, repo, true)).rejects.toThrow("not managed");
    await expect(service.removeWorktree(repo, "\0")).rejects.toThrow("Invalid path");
  });
  it("refuses redirected owned worktrees", async () => {
    const path = await service.createWorktree(repo, "redirected");
    const moved = join(temporary, "moved");
    await rename(path, moved);
    await symlink(moved, path, "junction");
    await expect(service.removeWorktree(repo, path, true)).rejects.toThrow("redirected");
    expect(await realpath(moved)).toBe(moved);
  });
  it("respects Git locks, including on forced removal", async () => {
    const path = await service.createWorktree(repo, "locked");
    await git("worktree", "lock", path);
    await expect(service.removeWorktree(repo, path, true)).rejects.toThrow();
    await git("worktree", "unlock", path);
    await service.removeWorktree(repo, path);
  });
});

it.each([false, true])(
  "rejects external replacements before removal (list first: %s)",
  async (listFirst) => {
    const path = await service.createWorktree(repo, "owned");
    await git("worktree", "remove", path);
    await git("worktree", "add", "-b", "external", path);
    await writeFile(join(path, "valuable"), "keep me");
    if (listFirst) {
      expect(await service.listWorktrees(repo)).toContainEqual(
        expect.objectContaining({ path, managed: false }),
      );
    }
    for (const force of [false, true]) {
      await expect(service.removeWorktree(repo, path, force)).rejects.toThrow("not managed");
      expect(await readFile(join(path, "valuable"), "utf8")).toBe("keep me");
    }
  },
);

it("invalidates ownership when metadata disappears", async () => {
  const path = await service.createWorktree(repo, "missing");
  await rm(join(path, ".git"));
  expect(await service.listWorktrees(repo)).toContainEqual(
    expect.objectContaining({ path, managed: false }),
  );
  await expect(service.removeWorktree(repo, path, true)).rejects.toThrow("not managed");
});

it("preserves ownership across ordinary branch and file changes", async () => {
  const path = await service.createWorktree(repo, "owned");
  await execute("git", ["checkout", "-b", "renamed"], { cwd: path });
  await writeFile(join(path, "new-file"), "content");
  expect(await service.listWorktrees(repo)).toContainEqual(
    expect.objectContaining({ path, branch: "renamed", managed: true }),
  );
  await service.removeWorktree(repo, path, true);
});

describe("persistent ownership", () => {
  const statePath = () => join(temporary, "user-data", "worktrees.json");
  const restart = () => WorktreeService.open(join(temporary, "user-data"), root);
  async function saved(): Promise<{
    version: number;
    repositories: unknown[];
    managed: Record<string, unknown>[];
  }> {
    const value: unknown = JSON.parse(await readFile(statePath(), "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      typeof value.version !== "number" ||
      !("repositories" in value) ||
      !Array.isArray(value.repositories) ||
      !("managed" in value) ||
      !Array.isArray(value.managed)
    )
      throw new Error("Invalid saved state");
    const managed: Record<string, unknown>[] = value.managed.filter(
      (entry: unknown): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null,
    );
    return { version: value.version, repositories: value.repositories, managed };
  }
  async function store(value: unknown) {
    await mkdir(dirname(statePath()), { recursive: true });
    await writeFile(statePath(), JSON.stringify(value));
  }
  it.each(["root", "adjacent"] as const)(
    "restores repositories and %s ownership, then persists removal",
    async (location) => {
      service = await restart();
      await service.addRepository(repo);
      const path = await service.createWorktree(repo, "persist/nested", { location });
      service = await restart();
      expect(service.listRepositories()).toEqual([{ path: repo, name: "repo with spaces" }]);
      expect(await service.listWorktrees(repo)).toContainEqual(
        expect.objectContaining({ path, managed: true }),
      );
      await service.removeWorktree(repo, path);
      expect((await saved()).managed).toEqual([]);
      expect(await (await restart()).listWorktrees(repo)).toHaveLength(1);
    },
  );
  it("serializes concurrent writes without losing repositories or ownership", async () => {
    service = await restart();
    await service.addRepository(repo);
    const paths = await Promise.all(
      ["one", "two"].map((branch) => service.createWorktree(repo, branch)),
    );
    service = await restart();
    for (const path of paths) await service.removeWorktree(repo, path);
    expect((await saved()).managed).toEqual([]);
  });
  it.each(["replace", "move", "redirect", "metadata"])(
    "drops ownership after %s across restart",
    async (kind) => {
      service = await restart();
      await service.addRepository(repo);
      const path = await service.createWorktree(repo, "persist");
      if (kind === "replace") {
        await git("worktree", "remove", path);
        await git("worktree", "add", "-b", "replacement", path);
      } else if (kind === "metadata") {
        await rm(join(path, ".git"));
      } else {
        const moved = join(temporary, "moved");
        await rename(path, moved);
        if (kind === "redirect") await symlink(moved, path, "junction");
      }
      service = await restart();
      await expect(service.removeWorktree(repo, path, true)).rejects.toThrow("not managed");
      expect((await saved()).managed).toEqual([]);
    },
  );
  it("persists invalidation from listing even if the original tree returns later", async () => {
    service = await restart();
    await service.addRepository(repo);
    const path = await service.createWorktree(repo, "persist");
    const metadata = await readFile(join(path, ".git"));
    await rm(join(path, ".git"));
    await service.listWorktrees(repo);
    expect((await saved()).managed).toEqual([]);
    await writeFile(join(path, ".git"), metadata);
    await expect((await restart()).removeWorktree(repo, path, true)).rejects.toThrow("not managed");
  });
  it.each([
    null,
    [],
    {},
    { version: 2, repositories: [], managed: [] },
    { version: 1, repositories: {}, managed: [] },
    { version: 1, repositories: [], managed: {} },
  ])("rejects invalid state %j", async (value) => {
    await store(value);
    expect((await restart()).listRepositories()).toEqual([]);
  });
  it("ignores malformed JSON and can subsequently save valid state", async () => {
    await store(null);
    await writeFile(statePath(), "{broken");
    service = await restart();
    expect(service.listRepositories()).toEqual([]);
    await service.addRepository(repo);
    expect((await restart()).listRepositories()).toHaveLength(1);
    await expect(WorktreeService.open("\0")).rejects.toThrow("Invalid path");
  });
  it("rejects hostile records and derives roots from configuration rather than stored claims", async () => {
    service = await restart();
    await service.addRepository(repo);
    const path = await service.createWorktree(repo, "persist");
    const state = await saved();
    const entry = state.managed[0];
    if (!entry) throw new Error("Missing record");
    const alias = join(temporary, "alias");
    await symlink(repo, alias, "junction");
    await store({
      version: 1,
      repositories: [repo, alias, temporary, join(temporary, "missing"), 1, "relative", "\0"],
      managed: [
        null,
        {},
        { ...entry, path: "relative" },
        { ...entry, repository: 1 },
        { ...entry, root: false },
        { ...entry, identity: {} },
        { ...entry, repository: join(temporary, "unknown") },
        { ...entry, root: dirname(temporary) },
        { ...entry, path: temporary, root: temporary },
        { ...entry, path: join(temporary, "not-a-tree"), root: temporary },
        { ...entry, path: repo, root: temporary },
      ],
    });
    service = await restart();
    expect(service.listRepositories()).toEqual([{ path: repo, name: "repo with spaces" }]);
    await expect(service.removeWorktree(repo, path, true)).rejects.toThrow("not managed");
    expect((await saved()).managed).toEqual([]);
  });
  it("does not restore ownership under a previously configured root", async () => {
    service = await restart();
    await service.addRepository(repo);
    const path = await service.createWorktree(repo, "persist");
    service = await WorktreeService.open(join(temporary, "user-data"), join(temporary, "new-root"));
    await expect(service.removeWorktree(repo, path, true)).rejects.toThrow("not managed");
  });
  it("does not accept a worktree belonging to a different repository", async () => {
    service = await restart();
    await service.addRepository(repo);
    await service.createWorktree(repo, "persist");
    const other = join(temporary, "other");
    await mkdir(other);
    await execute("git", ["init"], { cwd: other });
    await service.addRepository(other);
    const state = await saved();
    await store({
      ...state,
      managed: state.managed.map((entry) => ({ ...entry, repository: other })),
    });
    expect((await restart()).listRepositories()).toHaveLength(2);
    expect((await saved()).managed).toEqual([]);
  });
  it("reports failed writes, preserves the previous snapshot and can retry", async () => {
    service = await restart();
    await service.addRepository(repo);
    const original = await readFile(statePath(), "utf8");
    const backup = `${statePath()}.backup`;
    await rename(statePath(), backup);
    await mkdir(statePath());
    await expect(service.addRepository(repo)).rejects.toThrow();
    expect(await readFile(backup, "utf8")).toBe(original);
    await rm(statePath(), { recursive: true });
    await service.addRepository(repo);
    expect((await restart()).listRepositories()).toHaveLength(1);
  });
});
