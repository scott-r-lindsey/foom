import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import type { WorkspaceDependencies } from "../../../../src/main/workspace/workspace-types";
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
    "merged replacement graft",
    "merged legacy graft",
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
    if (!tree.head) throw new Error("Missing feature head");
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
    if (mode.startsWith("merged ")) {
      const integrated = (await git("rev-parse", "HEAD")).trim();
      const parent = (await git("rev-parse", "HEAD^1")).trim();
      if (mode.includes("replacement"))
        await git(
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "replace",
          "--graft",
          integrated,
          parent,
        );
      else {
        await mkdir(join(repo, ".git/info"), { recursive: true });
        await writeFile(join(repo, ".git/info/grafts"), `${integrated} ${parent}\n`);
      }
      await expect(git("merge-base", "--is-ancestor", tree.head, integrated)).rejects.toMatchObject(
        {
          code: 1,
        },
      );
      expect(await service.mergedCommit(repo, tree, await service.mergedDefault(repo, true))).toBe(
        true,
      );
    }
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
    ).toBe(mode.startsWith("merged"));
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
    "GitLab CRLF after squash",
    "GitLab configured merge driver",
    "GitLab invalid UTF-8 after squash",
    "GitLab forced-text NUL after squash",
    "GitLab root squash",
    "GitLab empty squash",
    "GitLab replacement graft",
    "GitLab legacy graft",
    "GitLab replaced tree",
    "GitLab replacement graft without forge",
    "GitHub unrelated merge ancestor",
    "GitHub replacement graft",
  ])("refuses %s claims for unmerged work through offline real Git", async (mode) => {
    const original = await feature();
    if (mode.includes("configured merge driver") || mode.includes("forced-text NUL"))
      await mkdir(join(repo, ".git/info"), { recursive: true });
    if (mode.includes("CRLF")) await git("config", "core.autocrlf", "false");
    if (mode.includes("configured merge driver")) {
      await writeFile(join(repo, ".git/info/attributes"), "feature.txt merge=tamper\n");
      await git("config", "merge.tamper.driver", "true");
      await git("config", "merge.renames", "true");
      await git("config", "merge.directoryRenames", "true");
      await git("config", "merge.renormalize", "true");
      await git("config", "diff.algorithm", "histogram");
    }
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
            : mode.includes("CRLF")
              ? "feature\r\n"
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
    if (mode.includes("replacement graft")) {
      await git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "replace",
        "--graft",
        hint,
        tree.head,
      );
      await git("merge-base", "--is-ancestor", tree.head, hint);
    }
    if (mode.includes("legacy graft")) {
      await mkdir(join(repo, ".git/info"), { recursive: true });
      await writeFile(join(repo, ".git/info/grafts"), `${hint} ${tree.head}\n`);
      await git("merge-base", "--is-ancestor", tree.head, hint);
    }
    if (mode.includes("replaced tree")) {
      const originalTree = (await git("rev-parse", `${hint}^{tree}`)).trim();
      const featureTree = (await git("rev-parse", `${tree.head}^{tree}`)).trim();
      await git("replace", originalTree, featureTree);
      // The proof's alternates can read both objects, but must never inherit
      // the source repository's mapping from one object to the other.
      expect((await git("rev-parse", `${hint}^{tree}`)).trim()).toBe(originalTree);
      expect(await git("ls-tree", "--name-only", hint)).toBe("feature.txt\n");
    }
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
    service = new WorktreeService(root, () =>
      mode.includes("without forge") ? undefined : provider,
    );
    await service.addRepository(repo);
    const base = await service.mergedDefault(repo, true);
    expect.soft(await service.mergedCommit(repo, tree, base)).toBe(false);
    expect
      .soft(
        await service.canAutoRemove(
          repo,
          tree.path,
          await service.removalIdentity(repo, tree.path),
        ),
      )
      .toBe(false);
    expect(transport).toHaveBeenCalled();
  });
  it("refuses a stale squash hint when an identical edit moves to a repeated block", async () => {
    const block = "before1\nbefore2\nbefore3\nold\nafter1\nafter2\nafter3\n";
    const changed = block.replace("old\n", "new\n");
    await writeFile(join(repo, "file.txt"), `${block}separator\n${block}`);
    await commit(repo, "repeated blocks");
    const { path } = await service.createWorktree(repo, "feature");
    await writeFile(join(path, "file.txt"), `${changed}separator\n${block}`);
    await commit(path, "edit first block");
    await writeFile(join(repo, "default.txt"), "default diverges\n");
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
    await commit(repo, "squash first-block edit");
    const hint = (await git("rev-parse", "HEAD")).trim();
    await writeFile(join(path, "file.txt"), `${block}separator\n${changed}`);
    await commit(path, "undo first edit and edit second block");
    await remote();
    const tree = (await service.listWorktrees(repo)).find((tree) => tree.path === path);
    if (!tree?.head) throw new Error("Missing feature head");
    const row = {
      iid: 7,
      source_branch: "feature",
      sha: tree.head,
      state: "merged",
      source_project_id: 1,
      target_project_id: 1,
      project_id: 1,
      head_pipeline: null,
      merge_commit_sha: null,
      squash_commit_sha: hint,
    };
    const provider = manifestForgeProvider(
      gitlabManifest,
      { host: "gitlab.com", project: "test/repo" },
      (argv) =>
        Promise.resolve({
          code: 0,
          stderr: "",
          stdout: JSON.stringify(argv[1]?.endsWith("/merge_requests") ? [row] : row),
        }),
      "main",
    );
    expect(await provider.lookup("feature", undefined, "all")).toMatchObject({
      state: "MERGED",
      headSha: tree.head,
      squashCommit: hint,
    });
    service = new WorktreeService(root, () => provider);
    await service.addRepository(repo);
    const base = await service.mergedDefault(repo, true);
    expect((await git("merge-tree", "--write-tree", base, tree.head)).trim()).not.toBe(
      (await git("rev-parse", `${base}^{tree}`)).trim(),
    );
    expect.soft(await service.mergedCommit(repo, tree, base)).toBe(false);
    expect
      .soft(await service.canAutoRemove(repo, path, await service.removalIdentity(repo, path)))
      .toBe(false);
  });
  it("refuses a squash hint with multiple merge bases", async () => {
    await git("switch", "-c", "left");
    await writeFile(join(repo, "left.txt"), "left\n");
    await commit(repo, "left base");
    await git("branch", "left-tip");
    await git("switch", "-c", "right", "main");
    await writeFile(join(repo, "right.txt"), "right\n");
    await commit(repo, "right base");
    await git("branch", "right-tip");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "merge",
      "--no-ff",
      "left-tip",
      "-m",
      "right cross merge",
    );
    await git("branch", "feature");
    await git("switch", "left");
    await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "merge",
      "--no-ff",
      "right-tip",
      "-m",
      "left cross merge",
    );
    const parent = (await git("rev-parse", "HEAD")).trim();
    await git("switch", "main");
    await git("reset", "--hard", parent);
    const { path } = await service.createWorktree(repo, "feature");
    await writeFile(join(path, "feature.txt"), "unmerged feature\n");
    await commit(path, "feature changes");
    await writeFile(join(repo, "feature.txt"), "different default change\n");
    await commit(repo, "claimed squash");
    const hint = (await git("rev-parse", "HEAD")).trim();
    await remote();
    const tree = (await service.listWorktrees(repo)).find((tree) => tree.path === path);
    if (!tree?.head) throw new Error("Missing feature head");
    expect((await git("merge-base", "--all", parent, tree.head)).trim().split(/\s+/u)).toHaveLength(
      2,
    );
    const row = {
      iid: 7,
      source_branch: "feature",
      sha: tree.head,
      state: "merged",
      source_project_id: 1,
      target_project_id: 1,
      project_id: 1,
      head_pipeline: null,
      merge_commit_sha: null,
      squash_commit_sha: hint,
    };
    const provider = manifestForgeProvider(
      gitlabManifest,
      { host: "gitlab.com", project: "test/repo" },
      (argv) =>
        Promise.resolve({
          code: 0,
          stderr: "",
          stdout: JSON.stringify(argv[1]?.endsWith("/merge_requests") ? [row] : row),
        }),
      "main",
    );
    expect(await provider.lookup("feature", undefined, "all")).toMatchObject({
      state: "MERGED",
      headSha: tree.head,
      squashCommit: hint,
    });
    service = new WorktreeService(root, () => provider);
    await service.addRepository(repo);
    const base = await service.mergedDefault(repo, true);
    expect(await service.mergedCommit(repo, tree, base)).toBe(false);
    expect(await service.canAutoRemove(repo, path, await service.removalIdentity(repo, path))).toBe(
      false,
    );
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

it.each(["detached", "untracked", "unpushed", "tracked", "external", "clean branch reset history"])(
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
    if (mode === "clean branch reset history") {
      await git("fetch", "origin");
      await execute(
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "Private reset history",
        ],
        { cwd: path },
      );
      await execute(["reset", "--hard", "HEAD~1"], { cwd: path });
      // New detached/leftover flows must retain this recovery history. Ordinary
      // clean branch removal keeps main's existing merge-evidence policy.
      await expect(service.cleanupChanges(repo, path)).rejects.toThrow("reflog");
    }
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
      if (mode === "detached" || mode === "untracked" || mode === "clean branch reset history") {
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
