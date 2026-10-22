import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import { manifestForgeProvider } from "../../../../src/main/control/forge-interpreter";
import { githubManifest, gitlabManifest } from "../../../../src/main/control/forge-manifests";
import { forgeValue } from "../../../../src/main/control/forge-mapping";
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
      expect(await service.mergedCommit(repo, { ...tree, branch: null }, base)).toBe(false);
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
  it.each(["merge", "squash", "both", "alternate ancestor", "no ancestor"])(
    "verifies GitLab %s integration SHAs for squash cleanup with offline real Git",
    async (mode) => {
      const tree = await feature();
      await writeFile(join(repo, "default.txt"), "diverge before squash\n");
      await commit(repo, "default change");
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
      const integrated = (await git("rev-parse", "HEAD")).trim();
      await writeFile(join(repo, "feature.txt"), "later default edit\n");
      await commit(repo, "later edit");
      const laterCommit = (await git("rev-parse", "HEAD")).trim();
      await remote();
      const envelope: unknown = JSON.parse(
        await readFile("spikes/forge-manifests/fixtures/glab-merged-rest-recorded.json", "utf8"),
      );
      const stdout = forgeValue(envelope, ["stdout"]);
      if (typeof stdout !== "string") throw new Error("Missing recorded response");
      const recorded: unknown = JSON.parse(stdout);
      if (typeof recorded !== "object" || recorded === null)
        throw new Error("Invalid recorded response");
      // Constructed integration evidence, derived from #718's reduced same-project MR.
      const row = {
        ...recorded,
        source_branch: "feature",
        sha: tree.head,
        merge_commit_sha:
          mode === "both"
            ? laterCommit
            : mode === "merge"
              ? integrated
              : mode === "squash"
                ? null
                : tree.head,
        squash_commit_sha:
          mode === "merge" ? null : mode === "no ancestor" ? "f".repeat(40) : integrated,
      };
      const transport = vi.fn((argv: readonly string[]) =>
        Promise.resolve({
          code: 0,
          stdout: JSON.stringify(argv[1]?.endsWith("/merge_requests") ? [row] : row),
          stderr: "",
        }),
      );
      service = new WorktreeService(root, () =>
        manifestForgeProvider(
          gitlabManifest,
          { host: "gitlab.com", project: "scott-test-projects/foom-forge-fixtures" },
          transport,
          "main",
        ),
      );
      await service.addRepository(repo);
      const base = await service.mergedDefault(repo, true);
      // Later edits make content-only containment insufficient. Original feature HEAD
      // is not an ancestor after squash; only the integrated SHA may authorize cleanup.
      await expect(git("merge-tree", "--write-tree", base, tree.head ?? "")).rejects.toThrow();
      expect(await service.mergedCommit(repo, tree, base)).toBe(mode !== "no ancestor");
      expect(
        await service.canAutoRemove(
          repo,
          tree.path,
          await service.removalIdentity(repo, tree.path),
        ),
      ).toBe(mode !== "no ancestor");
      expect(transport).toHaveBeenCalled();
    },
  );
  it.each([
    "GitLab unrelated merge ancestor",
    "GitLab unrelated squash ancestor",
    "GitLab stale squash",
    "GitLab whitespace after squash",
    "GitLab invalid UTF-8 after squash",
    "GitLab forced-text NUL after squash",
    "GitLab root squash",
    "GitLab empty squash",
    "GitHub unrelated merge ancestor",
  ])("refuses %s claims for unmerged work through offline real Git", async (mode) => {
    const original = await feature();
    if (mode.includes("invalid UTF-8")) {
      await writeFile(join(original.path, "feature.txt"), Buffer.from([0xfe, 0x0a]));
      await commit(original.path, "old non-UTF-8 content");
    }
    if (mode.includes("forced-text NUL")) {
      await writeFile(join(repo, ".git", "info", "attributes"), "feature.txt diff\n");
      await writeFile(join(original.path, "feature.txt"), Buffer.from([0, 0x61, 0x0a]));
      await commit(original.path, "old forced-text binary content");
    }
    const rootCommit = (await git("rev-parse", "main")).trim();
    await writeFile(join(repo, "unrelated.txt"), "old default change\n");
    await commit(repo, "unrelated default ancestor");
    let hint = (await git("rev-parse", "HEAD")).trim();
    if (mode.includes("after squash") || mode.includes("stale squash")) {
      await git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "merge",
        "--squash",
        "feature",
      );
      await commit(repo, "squash old feature head");
      hint = (await git("rev-parse", "HEAD")).trim();
      await writeFile(
        join(original.path, "feature.txt"),
        mode.includes("invalid UTF-8")
          ? Buffer.from([0xff, 0x0a])
          : mode.includes("forced-text NUL")
            ? Buffer.from([0, 0x62, 0x0a])
            : mode.includes("whitespace")
              ? "feature \n"
              : "new unmerged work\n",
      );
      await commit(original.path, "work added after squash");
    }
    if (mode.includes("root squash")) hint = rootCommit;
    if (mode.includes("empty squash")) {
      await git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "empty default commit",
      );
      hint = (await git("rev-parse", "HEAD")).trim();
    }
    // Prevent the content-containment path from deciding this case; the forged
    // hint is reachable, but default does not integrate the worktree's change set.
    await writeFile(join(repo, "feature.txt"), "conflicting default edit\n");
    await commit(repo, "default diverges");
    await remote();
    const tree = (await service.listWorktrees(repo)).find((tree) => tree.path === original.path);
    if (!tree?.head) throw new Error("Missing feature head");
    const squash = mode.includes("squash");
    const github = mode.startsWith("GitHub");
    const row = github
      ? {
          number: 579,
          headRefName: "feature",
          headRefOid: tree.head,
          state: "MERGED",
          isCrossRepository: false,
          headRepositoryOwner: { login: "test" },
          mergeCommit: { oid: hint },
        }
      : {
          iid: 7,
          source_branch: "feature",
          sha: tree.head,
          state: "merged",
          source_project_id: 1,
          target_project_id: 1,
          project_id: 1,
          head_pipeline: null,
          merge_commit_sha: squash ? null : hint,
          squash_commit_sha: squash ? hint : null,
        };
    const transport = vi.fn((argv: readonly string[]) =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify(
          github
            ? argv[1] === "list"
              ? [row]
              : argv[1] === "checks"
                ? []
                : row
            : argv[1]?.endsWith("/merge_requests")
              ? [row]
              : row,
        ),
      }),
    );
    const provider = manifestForgeProvider(
      github ? githubManifest : gitlabManifest,
      { host: github ? "github.com" : "gitlab.com", project: "test/repo" },
      transport,
      "main",
    );
    expect(await provider.lookup("feature", undefined, "all")).toMatchObject({
      state: "MERGED",
      headSha: tree.head,
      ...(squash ? { squashCommit: hint } : { mergeCommit: hint }),
    });
    service = new WorktreeService(root, () => provider);
    await service.addRepository(repo);
    const base = await service.mergedDefault(repo, true);
    expect(await service.mergedCommit(repo, tree, base)).toBe(false);
    expect(
      await service.canAutoRemove(repo, tree.path, await service.removalIdentity(repo, tree.path)),
    ).toBe(false);
    expect(transport).toHaveBeenCalled();
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
