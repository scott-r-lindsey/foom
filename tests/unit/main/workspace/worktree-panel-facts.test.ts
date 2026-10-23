import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it("deletes checked branches in one transaction, retaining moved and checked-out refs", async () => {
  const head = (await git("rev-parse", "HEAD")).trim();
  await git("branch", "deleted");
  await git("branch", "moved");
  await git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "next",
  );
  const next = (await git("rev-parse", "HEAD")).trim();
  await git("update-ref", "refs/heads/moved", next);
  expect(
    await service.deleteMergedBranches(repo, [
      { branch: "deleted", head },
      { branch: "moved", head },
      { branch: "main", head: next },
    ]),
  ).toEqual(["moved", "main"]);
  expect(await git("branch", "--list", "deleted")).toBe("");
  expect((await git("rev-parse", "moved")).trim()).toBe(next);
  await expect(
    service.deleteMergedBranches(repo, [{ branch: "invalid", head: "--bad" }]),
  ).rejects.toThrow("Invalid commit ID");
  expect(await service.deleteMergedBranches(repo, [{ branch: "absent", head }])).toEqual([
    "absent",
  ]);
  await git("branch", "locked-ref");
  await writeFile(join(repo, ".git", "refs", "heads", "locked-ref.lock"), "");
  expect(await service.deleteMergedBranches(repo, [{ branch: "locked-ref", head: next }])).toEqual([
    "locked-ref",
  ]);
  expect((await git("rev-parse", "locked-ref")).trim()).toBe(next);
});

it("reads the unambiguous forge remote locally without fetching", async () => {
  expect(await service.forgeRemote(repo)).toBeUndefined();
  await git("remote", "add", "origin", "https://github.com/fixture/offline.git");
  expect(await service.forgeRemote(repo)).toBe("https://github.com/fixture/offline.git");
  await git("remote", "rename", "origin", "upstream");
  expect(await service.forgeRemote(repo)).toBe("https://github.com/fixture/offline.git");
  await git("remote", "add", "second", "https://example.invalid/other");
  expect(await service.forgeRemote(repo)).toBeUndefined();
});

it("returns unavailable facts for a known prunable checkout without raising worktree-prunable", async () => {
  const { path } = await service.createWorktree(repo, "broken");
  await rm(join(path, ".git"));
  await writeFile(join(path, "leftover"), "keep until cleanup");
  for (let refresh = 0; refresh < 2; refresh++)
    await expect(service.panelFacts(repo, path)).resolves.toEqual({
      changes: null,
      upstream: null,
      commit: null,
      remote: null,
      defaultBranch: null,
      lastFetch: null,
      fetchFailed: false,
      merged: null,
    });
  await expect(service.panelFacts(repo, join(root, "not-recorded"))).rejects.toThrow(
    "worktree-missing",
  );
});
