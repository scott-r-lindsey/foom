import { Workspace } from "../../../../src/main/workspace/workspace";
import { evaluateRules } from "../../../../src/main/evaluator/evaluator";
import { git as execute } from "../../../helpers/git.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeService } from "../../../../src/main/workspace/worktrees";

let temporary: string;
let repo: string;
let root: string;
let service: WorktreeService;
async function git(...args: string[]): Promise<string> {
  const { stdout } = await execute(args, { cwd: repo });
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
    const first = await service.createWorktree(repo, "one");
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
    await expect(service.removeWorktree(repo, path, true)).rejects.toThrow("main checkout");
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
    await expect(service.removeWorktree(repo, external, true)).rejects.toThrow("main checkout");
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
    const path = await service.createWorktree(repo, "owned");
    const fresh = new WorktreeService(root);
    await fresh.addRepository(repo);
    expect(await fresh.removalIdentity(repo, path)).toBeTruthy();
    const other = join(temporary, "other");
    await mkdir(other);
    await execute(["init"], { cwd: other });
    await service.addRepository(other);
    await expect(service.removeWorktree(other, path, true)).rejects.toThrow("main checkout");
    await expect(service.removeWorktree(repo, repo, true)).rejects.toThrow("main checkout");
    await expect(service.removeWorktree(repo, "\0")).rejects.toThrow("Invalid path");
    await fresh.removeWorktree(repo, path);
    await expect(realpath(path)).rejects.toThrow();
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
  "rejects replacements after identity capture (list first: %s)",
  async (listFirst) => {
    const path = await service.createWorktree(repo, "owned");
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
  const path = await service.createWorktree(repo, "missing");
  await rm(join(path, ".git"));
  expect(await service.listWorktrees(repo)).toContainEqual(
    expect.objectContaining({ path, managed: false }),
  );
  await expect(service.removeWorktree(repo, path, true)).rejects.toThrow("main checkout");
});

it("preserves ownership across ordinary branch and file changes", async () => {
  const path = await service.createWorktree(repo, "owned");
  await execute(["checkout", "-b", "renamed"], { cwd: path });
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
      if (kind === "replace") await service.removeWorktree(repo, path);
      else await expect(service.removeWorktree(repo, path, true)).rejects.toThrow();
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
    await (await restart()).removeWorktree(repo, path);
    await expect(realpath(path)).rejects.toThrow();
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
    expect((await saved()).managed).toEqual([]);
    await service.removeWorktree(repo, path);
  });
  it("does not restore ownership under a previously configured root", async () => {
    service = await restart();
    await service.addRepository(repo);
    const path = await service.createWorktree(repo, "persist");
    service = await WorktreeService.open(join(temporary, "user-data"), join(temporary, "new-root"));
    await service.removeWorktree(repo, path);
  });
  it("does not accept a worktree belonging to a different repository", async () => {
    service = await restart();
    await service.addRepository(repo);
    await service.createWorktree(repo, "persist");
    const other = join(temporary, "other");
    await mkdir(other);
    await execute(["init"], { cwd: other });
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

it("reports dirty filenames for registered, unlocked linked worktrees", async () => {
  const tree = await service.createWorktree(repo, "inspect");
  expect(await service.changes(repo, tree)).toBe("");
  await writeFile(join(tree, "notes.txt"), "uncommitted");
  expect(await service.changes(repo, tree)).toBe("?? notes.txt\0");
  await expect(service.changes(repo, repo)).rejects.toThrow("main checkout");
  await git("worktree", "lock", tree);
  await expect(service.changes(repo, tree)).rejects.toThrow("locked");
});

it.each([false, true])(
  "preserves files created during worktree process shutdown (initially dirty=%s)",
  async (dirty) => {
    const tree = await service.createWorktree(repo, "shutdown-race");
    if (dirty) await writeFile(join(tree, "reviewed.txt"), "reviewed");
    const workspace = new Workspace({
      worktrees: service,
      terminals: {
        create: () => Promise.resolve("terminal"),
        kill: () => Promise.resolve(),
        stop: () => writeFile(join(tree, "NEW-AFTER-CONFIRM.txt"), "must survive"),
        tail: () => Promise.resolve([]),
      },
      verdicts: {
        forget: vi.fn(),
        classify: (input) =>
          Promise.resolve({
            id: "exit",
            terminalId: input.terminalId,
            timestamp: "now",
            verdict: evaluateRules(input),
          }),
        commit: () => Promise.resolve(),
        recordAction: () => Promise.resolve(),
      },
      receiver: () => Promise.reject(new Error("Hooks must not start")),
      onState: () => {},
      acknowledgeCodex: () => Promise.resolve(),
    });
    try {
      await workspace.startWorktree({
        repository: repo,
        branch: "shutdown-race",
        run: "shell",
        acknowledgeCodexNotifierReplacement: false,
      });
      await expect(
        workspace.removeWorktree("terminal", () => Promise.resolve(true)),
      ).rejects.toThrow("Review them");
      expect(await readFile(join(tree, "NEW-AFTER-CONFIRM.txt"), "utf8")).toBe("must survive");
      expect(workspace.snapshot().terminals).toHaveLength(1);
    } finally {
      await workspace.dispose();
    }
  },
);

it.each([false, true])(
  "explicitly removes an external worktree without adopting it (dirty=%s)",
  async (dirty) => {
    const path = join(temporary, "external");
    await git("worktree", "add", "-b", "external", path);
    if (dirty) await writeFile(join(path, "notes.txt"), "keep until confirmed");
    const identity = await service.removalIdentity(repo, path);
    expect(await service.changes(repo, path, identity)).toBe(dirty ? "?? notes.txt\0" : "");
    expect(await service.listWorktrees(repo)).toContainEqual(
      expect.objectContaining({ path, managed: false }),
    );
    if (dirty) await expect(service.removeWorktree(repo, path, false, identity)).rejects.toThrow();
    await service.removeWorktree(repo, path, dirty, identity);
    await expect(realpath(path)).rejects.toThrow();
    expect((await git("branch", "--list", "external")).trim()).toBe("external");
  },
);

it("rejects replacement external worktrees even when their dirty filenames match", async () => {
  const path = join(temporary, "external");
  await git("worktree", "add", "-b", "external", path);
  await writeFile(join(path, "notes.txt"), "reviewed");
  const identity = await service.removalIdentity(repo, path);
  await git("worktree", "remove", "--force", path);
  await git("worktree", "add", "-b", "replacement", path);
  await writeFile(join(path, "notes.txt"), "unreviewed");
  await expect(service.changes(repo, path, identity)).rejects.toThrow("replaced");
  await expect(service.removeWorktree(repo, path, true, identity)).rejects.toThrow("replaced");
  expect(await readFile(join(path, "notes.txt"), "utf8")).toBe("unreviewed");
});

it("rejects main, missing, locked, prunable, bare and unrelated removal targets", async () => {
  const path = join(temporary, "external");
  await git("worktree", "add", "-b", "external", path);
  await expect(service.removalIdentity(repo, repo)).rejects.toThrow("main checkout");
  await expect(service.removalIdentity(repo, temporary)).rejects.toThrow("missing");
  await expect(service.removalIdentity(repo, "\0")).rejects.toThrow("Invalid path");
  const identity = await service.removalIdentity(repo, path);
  await git("worktree", "lock", path);
  await expect(service.removeWorktree(repo, path, true, identity)).rejects.toThrow("locked");
  await git("worktree", "unlock", path);
  const inventory = await service.listWorktrees(repo);
  const listing = vi.spyOn(service, "listWorktrees");
  for (const flags of [{ prunable: true }, { bare: true }]) {
    listing.mockResolvedValueOnce(
      inventory.map((tree) => (tree.path === path ? { ...tree, ...flags } : tree)),
    );
    await expect(service.removalIdentity(repo, path)).rejects.toThrow("main checkout");
  }
  listing.mockRestore();
  await service.addRepository(path);
  await expect(service.removalIdentity(path, repo)).rejects.toThrow("not a linked checkout");
  const other = join(temporary, "other");
  await mkdir(other);
  await execute(["init"], { cwd: other });
  await service.addRepository(other);
  await expect(service.removalIdentity(other, path)).rejects.toThrow("missing");
  await rm(join(path, ".git"));
  await writeFile(join(path, ".git"), `gitdir: ${join(other, ".git")}\n`);
  await expect(service.removalIdentity(repo, path)).rejects.toThrow("not a linked checkout");
});

it("rejects redirected external worktrees before inspection or removal", async () => {
  const path = join(temporary, "external");
  await git("worktree", "add", "-b", "external", path);
  const identity = await service.removalIdentity(repo, path);
  const moved = join(temporary, "moved");
  await rename(path, moved);
  await symlink(moved, path, "junction");
  await expect(service.changes(repo, path, identity)).rejects.toThrow("redirected");
  await expect(service.removeWorktree(repo, path, true, identity)).rejects.toThrow("redirected");
  expect(await realpath(moved)).toBe(moved);
});

it("validates main, external and detached launch locations without acquiring ownership", async () => {
  const path = join(temporary, "external");
  await git("worktree", "add", "--detach", path);
  expect(await service.launchIdentity(repo, repo)).toEqual(expect.any(String));
  const identity = await service.launchIdentity(repo, path);
  expect(identity).toEqual(expect.any(String));
  expect(await service.listWorktrees(repo)).toContainEqual(
    expect.objectContaining({ path, managed: false, branch: null }),
  );
  await git("worktree", "lock", path);
  await expect(service.launchIdentity(repo, path)).rejects.toThrow("locked");
  await git("worktree", "unlock", path);
  await git("worktree", "remove", path);
  await git("worktree", "add", "--detach", path);
  expect(await service.launchIdentity(repo, path)).not.toBe(identity);
  await expect(service.launchIdentity(repo, temporary)).rejects.toThrow("missing");
});

it("derives watch directories from common Git metadata, including linked and packed repositories", async () => {
  const common = join(repo, ".git");
  expect(await service.watchPaths(repo)).toEqual([
    common,
    join(common, "refs"),
    join(common, "refs", "heads"),
  ]);
  await git("branch", "topic/nested/feature");
  const linked = join(temporary, "linked");
  await git("worktree", "add", linked, "topic/nested/feature");
  await service.addRepository(linked);
  const paths = await service.watchPaths(linked);
  expect(paths).toEqual(await service.watchPaths(repo));
  expect(paths).toContain(join(common, "refs", "heads", "topic", "nested"));
  expect(paths).toContain(join(common, "worktrees", "linked"));
  await git("pack-refs", "--all", "--prune");
  expect(await service.watchPaths(repo)).toContain(common);
  await expect(service.watchPaths(temporary)).rejects.toThrow("has not been added");
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
    const path = await service.createWorktree(repo, "feature");
    await writeFile(join(path, "feature.txt"), "feature\n");
    await commit(path, "feature");
    const tree = (await service.listWorktrees(repo)).find((tree) => tree.path === path);
    if (!tree) throw new Error("Missing fixture");
    return tree;
  }
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
      expect(await service.mergedCommit(repo, { ...tree, branch: null }, base)).toBe(false);
      await expect(service.mergedCommit(repo, tree, "--bad")).rejects.toThrow("Invalid commit");
      await expect(service.mergedCommit(repo, { ...tree, head: "bad" }, base)).rejects.toThrow(
        "Invalid commit",
      );
    },
  );
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
    await expect(service.mergedDefault(repo)).rejects.toThrow("remote");
    const upstream = await remote();
    const base = await service.mergedDefault(repo, true);
    await git("remote", "set-url", "origin", join(temporary, "missing"));
    expect(await service.mergedDefault(repo)).toBe(base);
    await expect(service.mergedDefault(repo, true)).rejects.toThrow("fetch failed");
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

it.each(["untracked", "commit"])(
  "merged cleanup preserves a real worktree gaining %s after confirmation",
  async (change) => {
    const tree = await service.createWorktree(repo, "changed");
    const removed = await service.createWorktree(repo, "safe");
    const upstream = join(temporary, "remote.git");
    await git("clone", "--bare", repo, upstream);
    await git("remote", "add", "origin", upstream);
    const workspace = new Workspace({
      worktrees: service,
      terminals: {
        create: () => Promise.reject(new Error("No launch expected")),
        kill: () => Promise.resolve(),
        stop: () => Promise.resolve(),
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
      acknowledgeCodex: () => Promise.resolve(),
    });
    try {
      await expect(
        workspace.sidebarCommand(
          { kind: "delete-merged-worktrees", repository: repo },
          async () => {
            await writeFile(join(tree, "new.txt"), "must survive");
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
      ).rejects.toThrow("Skipped: changed:");
      expect(await readFile(join(tree, "new.txt"), "utf8")).toBe("must survive");
      expect(await git("branch", "--list", "changed")).toContain("changed");
      await expect(realpath(removed)).rejects.toThrow();
      expect(await git("branch", "--list", "safe")).toBe("");
    } finally {
      await workspace.dispose();
    }
  },
);

it("status inspection never refreshes the index during concurrent cleanup", async () => {
  const path = await service.createWorktree(repo, "status-read");
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

describe("local panel facts", () => {
  it("reports changes, commit and unknown upstream without fetching; caches briefly", async () => {
    await writeFile(join(repo, "note.txt"), "draft");
    const facts = await service.panelFacts(repo, repo);
    expect(facts).toMatchObject({
      changes: 1,
      upstream: null,
      remote: null,
      merged: null,
      commit: { subject: "Initial" },
    });
    await writeFile(join(repo, "other.txt"), "draft");
    expect(await service.panelFacts(repo, repo)).toEqual(facts);
    await expect(service.panelFacts(repo, temporary)).rejects.toThrow();
    await expect(service.panelFacts(temporary, repo)).rejects.toThrow();
  });
  it("shows unknown for git failures after authorization", async () => {
    vi.spyOn(service, "launchIdentity").mockResolvedValue("verified");
    const facts = await service.panelFacts(repo, temporary);
    expect(facts).toMatchObject({ changes: null, upstream: null, commit: null, remote: null });
  });
});

it("repository panels read local default branch and fetch time without network or linked worktrees", async () => {
  await git("remote", "add", "upstream", "https://invalid.example/repo.git");
  const head = (await git("rev-parse", "HEAD")).trim();
  await git("update-ref", "refs/remotes/upstream/main", head);
  await git("symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/main");
  await git("branch", "--set-upstream-to=upstream/main", "main");
  await writeFile(join(repo, ".git", "FETCH_HEAD"), `${head}\t\tbranch 'main'\n`);
  const facts = await service.panelFacts(repo, repo);
  expect(facts.defaultBranch).toBe("main");
  expect(facts.remote).toBe("https://invalid.example/repo.git");
  expect(facts.lastFetch).toBeGreaterThan(0);
  expect(facts.upstream).toEqual({ ahead: 0, behind: 0 });
  expect(facts.fetchFailed).toBe(false);
  expect(await service.listWorktrees(repo)).toHaveLength(1);
});
