import * as fs from "node:fs/promises";
import { WorktreeStore } from "../../../../src/main/workspace/worktree-store";
import { lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as operations from "../../../../src/main/workspace/worktree-operations";
import {
  checkRemovalRetry,
  sameRemovalPath,
} from "../../../../src/main/workspace/worktree-removal-retry";
import { WorktreeService } from "../../../../src/main/workspace/worktrees";
import { git } from "../../../helpers/git.js";
import { nativeDeadline } from "../../../helpers/native-test-policy";
import { createWorktreeFixture } from "./worktree-git-fixture";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
vi.mock("../../../../src/main/workspace/worktree-operations", async (original) => ({
  ...(await original<typeof operations>()),
}));
vi.setConfig({ testTimeout: nativeDeadline(5000), hookTimeout: nativeDeadline(10_000) });
const fixture = createWorktreeFixture();
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.cleanup();
});

test.each([
  ["C:\\Foom\\Repo\\Child", "c:/foom/repo/child", true],
  ["C:\\Foom\\Repo\\Child", "\\\\?\\C:\\Foom\\Repo\\Child", true],
  ["\\\\Server\\Share\\Child", "\\\\?\\UNC\\server\\share\\child", true],
  ["C:\\Foom\\Repo\\Child", "D:\\Foom\\Repo\\Child", false],
  ["C:\\Foom\\Repo\\Child", "C:\\Foom\\Repo\\Child-other", false],
])("Windows membership refusal compares %s with %s", (left, right, expected) => {
  expect(sameRemovalPath(left, right, true)).toBe(expected);
});

test("POSIX membership remains case sensitive", () => {
  expect(sameRemovalPath("/root/child", "/root/child", false)).toBe(true);
  expect(sameRemovalPath("/root/Child", "/root/child", false)).toBe(false);
});

test(
  "directory identity retains bigint inode precision and stays stable when contents change",
  fixture.usingFixture(async () => {
    const { repo, service } = await fixture.create();
    const { path } = await service.createWorktree(repo, "identity");
    const before = await operations.parentIdentity(path);
    await writeFile(join(path, "new-file"), "changed contents");
    expect(await operations.parentIdentity(path)).toBe(before);
    const stat = await fs.lstat(path, { bigint: true });
    stat.ino = 9007199254740993n;
    vi.spyOn(fs, "lstat").mockResolvedValueOnce(stat);
    const large = await operations.parentIdentity(path);
    expect(large.split(":")[1]).toBe("9007199254740993");
    stat.ino += 1n;
    vi.spyOn(fs, "lstat").mockResolvedValueOnce(stat);
    expect(await operations.parentIdentity(path)).not.toBe(large);
  }),
);

async function pendingFixture() {
  const { temporary, repo, root } = await fixture.create();
  const profile = join(temporary, "profile");
  const service = await WorktreeService.open(profile, root);
  await service.addRepository(repo);
  const { path } = await service.createWorktree(repo, "feature/retry");
  await writeFile(join(path, "retained"), "retained data");
  const spy = vi.spyOn(operations, "git").mockImplementation(async (cwd, args) => {
    if (args[0] === "worktree" && args[1] === "remove") {
      // Preserve the directory inode while simulating a partial Git removal.
      await rm(join(path, ".git"));
      await git(["worktree", "prune", "--expire", "now"], { cwd });
      return "";
    }
    return (await git(args, { cwd })).stdout;
  });
  await expect(service.removeWorktree(repo, path, true)).rejects.toThrow(
    "worktree-removal-incomplete",
  );
  spy.mockRestore();
  return { service, repo, root, path, profile, temporary };
}

for (const unavailable of [false, true]) {
  test(
    `retry resolves registered short-name aliases and refuses ${unavailable ? "unavailable resolution" : "re-registration"}`,
    fixture.usingFixture(async () => {
      const { profile, root, path } = await pendingFixture();
      const entry = (await new WorktreeStore(join(profile, "worktrees.json")).read())
        ?.pendingRemovals?.[0];
      if (!entry) throw new Error("Missing pending removal");
      const resolve = vi.spyOn(fs, "realpath").mockResolvedValueOnce(root);
      if (unavailable)
        resolve.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { code: "EACCES" }));
      else resolve.mockResolvedValueOnce(path);
      await expect(
        checkRemovalRetry(entry, root, () => Promise.resolve(["C:\\FOOM~1\\child"])),
      ).rejects.toMatchObject({
        reason: unavailable ? "membership-unavailable" : "re-registered",
      });
      expect(await readFile(join(path, "retained"), "utf8")).toBe("retained data");
    }),
  );
}

test(
  "an unrelated missing registered directory does not hide the current retry target",
  fixture.usingFixture(async () => {
    const { profile, root, path } = await pendingFixture();
    const entry = (await new WorktreeStore(join(profile, "worktrees.json")).read())
      ?.pendingRemovals?.[0];
    if (!entry) throw new Error("Missing pending removal");
    await expect(
      checkRemovalRetry(entry, root, () => Promise.resolve([`${path}-missing`])),
    ).resolves.toBe("present");
  }),
);

test(
  "retry removes only the original directory and persists success across restart",
  fixture.usingFixture(async () => {
    const { service, repo, path, profile, root } = await pendingFixture();
    expect(await service.listWorktrees(repo)).toContainEqual(
      expect.objectContaining({ path, removalFailed: true }),
    );
    await service.cleanupBrokenWorktree(repo, path);
    await expect(lstat(path)).rejects.toThrow();
    const restored = await WorktreeService.open(profile, root);
    await restored.reconcileRemovals();
    expect(await restored.listWorktrees(repo)).not.toContainEqual(
      expect.objectContaining({ path }),
    );
  }),
);

test(
  "startup revalidates and retries a persisted incomplete removal once",
  fixture.usingFixture(async () => {
    const { repo, path, profile, root } = await pendingFixture();
    const restored = await WorktreeService.open(profile, root);
    expect(await readFile(join(path, "retained"), "utf8")).toBe("retained data");
    await restored.reconcileRemovals();
    await expect(lstat(path)).rejects.toThrow();
    expect(await restored.listWorktrees(repo)).not.toContainEqual(
      expect.objectContaining({ path }),
    );
  }),
);

test("startup without pending removals performs no Git inspection", async () => {
  const inspect = vi.spyOn(operations, "git");
  await new WorktreeService().reconcileRemovals();
  expect(inspect).not.toHaveBeenCalled();
});

for (const stage of ["before", "membership", "deletion", "budget"] as const) {
  test(
    `startup stops at ${stage} without deleting and leaves manual retry available`,
    fixture.usingFixture(async () => {
      const { service, repo, path, profile, root } = await pendingFixture();
      if (stage === "membership") await service.addRepository((await fixture.create()).repo);
      const restored = await WorktreeService.open(profile, root);
      let cancelled = stage === "before";
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const inspect = vi.spyOn(operations, "git").mockImplementation(async (cwd, args, timeout) => {
        expect(timeout).toBeGreaterThan(0);
        expect(timeout).toBeLessThanOrEqual(5000);
        const result = (await git(args, { cwd })).stdout;
        if (stage === "budget") clock.mockReturnValue(6000);
        else cancelled = true;
        return result;
      });
      await restored.reconcileRemovals(() => cancelled);
      const calls = inspect.mock.calls.length;
      await restored.reconcileRemovals();
      expect(inspect).toHaveBeenCalledTimes(calls);
      expect(calls).toBe(stage === "before" ? 0 : 1);
      if (stage !== "before")
        expect(log).toHaveBeenCalledWith(
          "Worktree removal retry refused: startup-interrupted",
          path,
        );
      expect(await readFile(join(path, "retained"), "utf8")).toBe("retained data");
      clock.mockRestore();
      inspect.mockRestore();
      await restored.cleanupBrokenWorktree(repo, path);
      await expect(lstat(path)).rejects.toThrow();
    }),
  );
}

for (const refusal of [
  "symlink",
  "symlinked-ancestor",
  "inode-mismatch",
  "git-present",
  "outside-root",
] as const) {
  test(
    `startup and manual retry refuse ${refusal} and preserve files`,
    fixture.usingFixture(async () => {
      const { repo, path, profile, root, temporary } = await pendingFixture();
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const retained = join(path, "retained");
      let configuredRoot = root;
      if (refusal === "symlink") {
        const moved = join(temporary, "original");
        await rename(path, moved);
        await symlink(moved, path, "junction");
      } else if (refusal === "symlinked-ancestor") {
        const parent = join(root, "repo with spaces", "feature");
        const moved = join(temporary, "parent");
        await rename(parent, moved);
        await symlink(moved, parent, "junction");
      } else if (refusal === "inode-mismatch") {
        await rename(path, `${path}-original`);
        await mkdir(path);
        await writeFile(retained, "replacement data");
      } else if (refusal === "git-present") {
        await mkdir(join(path, ".git"));
      } else {
        configuredRoot = join(temporary, "other-root");
        await mkdir(configuredRoot);
      }
      const restored = await WorktreeService.open(profile, configuredRoot);
      await restored.reconcileRemovals();
      expect(await restored.listWorktrees(repo)).toContainEqual(
        expect.objectContaining({ path, removalFailed: true }),
      );
      await expect(restored.cleanupBrokenWorktree(repo, path)).rejects.toThrow(
        "worktree-removal-incomplete",
      );
      expect(await readFile(retained, "utf8")).toBe(
        refusal === "inode-mismatch" ? "replacement data" : "retained data",
      );
      expect(log).toHaveBeenCalledWith(`Worktree removal retry refused: ${refusal}`, path);
    }),
  );
}

test(
  "re-registration in another known repository drops retry authority permanently",
  fixture.usingFixture(async () => {
    const { service, path, profile, root } = await pendingFixture();
    const other = await fixture.create();
    await service.addRepository(other.repo);
    await rm(path, { recursive: true });
    await git(["worktree", "add", "-b", "registered", path], { cwd: other.repo });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await (await WorktreeService.open(profile, root)).reconcileRemovals();
    expect(log).toHaveBeenCalledWith("Worktree removal retry refused: re-registered", path);
    expect(await lstat(join(path, ".git"))).toBeDefined();
    const state: unknown = JSON.parse(await readFile(join(profile, "worktrees.json"), "utf8"));
    expect(state).toMatchObject({ pendingRemovals: [] });
  }),
);

for (const unavailable of [false, true]) {
  test(
    `prunable re-registration preserves new data when its saved repository is ${unavailable ? "unavailable" : "available"}`,
    fixture.usingFixture(async () => {
      const { service, repo, path, profile, root } = await pendingFixture();
      const other = await fixture.create();
      await service.addRepository(other.repo);
      const identity = await operations.parentIdentity(path);
      await rm(join(path, "retained"));
      await git(["worktree", "add", "-b", "re-registered", path], { cwd: other.repo });
      expect(await operations.parentIdentity(path)).toBe(identity);
      await rm(join(path, ".git"));
      await writeFile(join(path, "retained"), "new data from the other repository");
      if (unavailable) await rename(other.repo, `${other.repo}-offline`);
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const restored = await WorktreeService.open(profile, root);
      await restored.reconcileRemovals();
      expect(await readFile(join(path, "retained"), "utf8")).toBe(
        "new data from the other repository",
      );
      if (unavailable) {
        expect(log).toHaveBeenCalledWith(
          "Worktree removal retry refused: membership-unavailable",
          path,
        );
        expect(restored.listRepositories()).not.toContainEqual(
          expect.objectContaining({ path: other.repo }),
        );
        // An unrelated registration save must retain the unavailable identity too.
        await restored.addRepository(repo);
        const saved = await new WorktreeStore(join(profile, "worktrees.json")).read();
        expect(saved?.repositories).toContain(other.repo);
        expect(saved?.pendingRemovals).toContainEqual(expect.objectContaining({ path }));
        const again = await WorktreeService.open(profile, root);
        await again.reconcileRemovals();
        expect(await readFile(join(path, "retained"), "utf8")).toBe(
          "new data from the other repository",
        );
        await rename(`${other.repo}-offline`, other.repo);
        await again.addRepository(other.repo);
        await expect(again.cleanupBrokenWorktree(repo, path)).rejects.toThrow(
          "worktree-removal-incomplete",
        );
        expect(log).toHaveBeenCalledWith("Worktree removal retry refused: re-registered", path);
        expect(
          (await new WorktreeStore(join(profile, "worktrees.json")).read())?.pendingRemovals,
        ).toEqual([]);
        expect(await readFile(join(path, "retained"), "utf8")).toBe(
          "new data from the other repository",
        );
      }
    }),
  );
}

test(
  "pending removal survives its owning repository being unavailable across startup",
  fixture.usingFixture(async () => {
    const { repo, path, profile, root } = await pendingFixture();
    await rename(repo, `${repo}-offline`);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const restored = await WorktreeService.open(profile, root);
    await restored.reconcileRemovals();
    expect(log).toHaveBeenCalledWith(
      "Worktree removal retry refused: membership-unavailable",
      path,
    );
    expect(
      (await new WorktreeStore(join(profile, "worktrees.json")).read())?.pendingRemovals,
    ).toContainEqual(expect.objectContaining({ path }));
    expect(await readFile(join(path, "retained"), "utf8")).toBe("retained data");
    await rename(`${repo}-offline`, repo);
    const recovered = await WorktreeService.open(profile, root);
    await recovered.reconcileRemovals();
    await expect(lstat(path)).rejects.toThrow();
  }),
);

test(
  "a user-created directory never grants retry authority",
  fixture.usingFixture(async () => {
    const { service, repo, root } = await fixture.create();
    const path = join(root, "manual");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "retained"), "user data");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(service.retryRemoval(repo, path)).rejects.toThrow("worktree-removal-incomplete");
    expect(log).toHaveBeenCalledWith("Worktree removal retry refused: not-created-by-foom", path);
    expect(await readFile(join(path, "retained"), "utf8")).toBe("user data");
  }),
);

test(
  "retry refuses non-directories and Git marker files, and treats absent directories as complete",
  fixture.usingFixture(async () => {
    const { service, repo, root } = await fixture.create();
    const { path } = await service.createWorktree(repo, "check");
    const entry = {
      path,
      repository: repo,
      root,
      directoryIdentity: await operations.parentIdentity(path),
    };
    await expect(checkRemovalRetry(entry, root, () => Promise.resolve([]))).rejects.toThrow(
      "git-present",
    );
    await rename(path, `${path}-old`);
    await writeFile(path, "file");
    await expect(checkRemovalRetry(entry, root, () => Promise.resolve([]))).rejects.toThrow(
      "not-directory",
    );
    await rm(path);
    expect(await checkRemovalRetry(entry, root, () => Promise.resolve([]))).toBe("missing");
  }),
);

test(
  "pending presentation rows never authorize legacy prune or normal removal",
  fixture.usingFixture(async () => {
    const { service, repo, path } = await pendingFixture();
    await expect(service.pruneWorktree(repo, path)).rejects.toThrow("prune-unsafe");
    await expect(service.removeWorktree(repo, path, true)).rejects.toThrow("worktree-missing");
    expect(await readFile(join(path, "retained"), "utf8")).toBe("retained data");
  }),
);

test(
  "unknown or unreadable membership refuses one startup attempt and retains the failure",
  fixture.usingFixture(async () => {
    const { service, repo, path } = await pendingFixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spy = vi.spyOn(operations, "git").mockRejectedValue(new Error("unavailable"));
    await expect(service.retryRemoval(repo, path)).rejects.toThrow("worktree-removal-incomplete");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "Worktree removal retry refused: inspection-or-delete-failed",
      path,
    );
    expect(await readFile(join(path, "retained"), "utf8")).toBe("retained data");
    spy.mockRestore();
    expect(await service.listWorktrees(repo)).toContainEqual(
      expect.objectContaining({ path, removalFailed: true }),
    );
  }),
);

test(
  "delete failure remains persisted with one attempt per trigger and no inventory retry",
  fixture.usingFixture(async () => {
    const { service, repo, path, profile, root } = await pendingFixture();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const original = fs.rm;
    let attempts = 0;
    const remove = vi.spyOn(fs, "rm").mockImplementation((target, options) => {
      if (target === path) {
        attempts += 1;
        return Promise.reject(new Error("busy"));
      }
      return original(target, options);
    });
    await expect(service.cleanupBrokenWorktree(repo, path)).rejects.toThrow(
      "worktree-removal-incomplete",
    );
    expect(attempts).toBe(1);
    const restored = await WorktreeService.open(profile, root);
    await restored.reconcileRemovals();
    expect(attempts).toBe(2);
    expect(await restored.listWorktrees(repo)).toContainEqual(
      expect.objectContaining({ path, removalFailed: true }),
    );
    await restored.listWorktrees(repo);
    expect(attempts).toBe(2);
    remove.mockRestore();
    await restored.cleanupBrokenWorktree(repo, path);
    await expect(lstat(path)).rejects.toThrow();
  }),
);

test(
  "concurrent triggers cannot start a second deletion attempt",
  fixture.usingFixture(async () => {
    const { service, repo, path } = await pendingFixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const inventory = (await git(["worktree", "list", "--porcelain", "-z"], { cwd: repo })).stdout;
    const entered = Promise.withResolvers<undefined>();
    const listing = Promise.withResolvers<string>();
    const original = operations.git;
    vi.spyOn(operations, "git").mockImplementation((cwd, args) => {
      if (args[0] === "worktree" && args[1] === "list") {
        entered.resolve(undefined);
        return listing.promise;
      }
      return original(cwd, args);
    });
    const first = service.retryRemoval(repo, path);
    try {
      await entered.promise;
      await expect(service.retryRemoval(repo, path)).rejects.toThrow("worktree-removal-incomplete");
      expect(log).toHaveBeenCalledWith("Worktree removal retry refused: retry-in-progress", path);
    } finally {
      listing.resolve(inventory);
      await first;
    }
    await expect(lstat(path)).rejects.toThrow();
  }),
);

test(
  "persisted outside-root paths are refused even with a matching directory identity",
  fixture.usingFixture(async () => {
    const { profile, repo, root, temporary } = await pendingFixture();
    const outside = join(temporary, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "retained"), "outside data");
    const store = new WorktreeStore(join(profile, "worktrees.json"));
    const state = await store.read();
    if (!state) throw new Error("Missing state");
    const directoryIdentity = await operations.parentIdentity(outside);
    await store.save(() => ({
      ...state,
      pendingRemovals: [{ path: outside, repository: repo, root, directoryIdentity }],
    }));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await (await WorktreeService.open(profile, root)).reconcileRemovals();
    expect(log).toHaveBeenCalledWith("Worktree removal retry refused: outside-root", outside);
    expect(await readFile(join(outside, "retained"), "utf8")).toBe("outside data");
  }),
);

test(
  "malformed retry records grant no authority",
  fixture.usingFixture(async () => {
    const { temporary } = await fixture.create();
    const file = join(temporary, "state.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        repositories: [],
        managed: [],
        pendingRemovals: [
          null,
          {},
          { path: "/tmp/relative", repository: "/repo", root: "/root", directoryIdentity: 1 },
          { path: "relative", repository: "/repo", root: "/root", directoryIdentity: "id" },
        ],
      }),
    );
    expect(await new WorktreeStore(file).read()).toMatchObject({ pendingRemovals: [] });
  }),
);
