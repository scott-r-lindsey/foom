import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateRules } from "../../../../src/main/evaluator/evaluator";
import { Workspace } from "../../../../src/main/workspace/workspace";
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
      const { path } = await service.createWorktree(repo, "persist/nested", { location });
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
      ["one", "two"].map(async (branch) => (await service.createWorktree(repo, branch)).path),
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
      const { path } = await service.createWorktree(repo, "persist");
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
    const { path } = await service.createWorktree(repo, "persist");
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
    const { path } = await service.createWorktree(repo, "persist");
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
    const { path } = await service.createWorktree(repo, "persist");
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
  const tree = (await service.createWorktree(repo, "inspect")).path;
  expect(await service.changes(repo, tree)).toBe("");
  await writeFile(join(tree, "notes.txt"), "uncommitted");
  expect(await service.changes(repo, tree)).toBe("?? notes.txt\0");
  await expect(service.changes(repo, repo)).rejects.toThrow("worktree-main");
  await git("worktree", "lock", tree);
  await expect(service.changes(repo, tree)).rejects.toThrow("locked");
});

it.each([false, true])(
  "preserves files created during worktree process shutdown (initially dirty=%s)",
  async (dirty) => {
    const tree = (await service.createWorktree(repo, "shutdown-race")).path;
    if (dirty) await writeFile(join(tree, "reviewed.txt"), "reviewed");
    const workspace = new Workspace({
      worktrees: service,
      terminals: {
        create: () => Promise.resolve("terminal"),
        kill: () => Promise.resolve(),
        stop: async () => {
          await writeFile(join(tree, "NEW-AFTER-CONFIRM.txt"), "must survive");
          return true;
        },
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
    });
    try {
      await workspace.startWorktree({
        repository: repo,
        branch: "shutdown-race",
        run: "shell",
      });
      await workspace.exited("terminal", 0);
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
  await expect(service.removalIdentity(repo, repo)).rejects.toThrow("worktree-main");
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
    await expect(service.removalIdentity(repo, path)).rejects.toThrow(
      flags.prunable ? "worktree-prunable" : "worktree-missing",
    );
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

// Four setup Git processes (init, commit, two registration probes), then nine
// here: four watchPaths probes, branch/worktree/pack-refs, and two linked probes.
// A Linux exec trace also sees three Git children (maintenance, symbolic-ref, reset).
it(
  "derives watch directories from common Git metadata, including linked and packed repositories",
  usingFixture(async () => {
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
  }),
);
