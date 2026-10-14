import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { git } from "../../../helpers/git.js";
import { FAKE_GH } from "../../../helpers/forge-cli.js";
import { forgeProvider } from "../../../../src/main/control/forge";
import { WorktreeService } from "../../../../src/main/workspace/worktrees";
import { UncertainEffect } from "../../../../src/main/control/orchestration";
let root: string;
let repo: string;
let remote: string;
let fixture: string;
let service: WorktreeService;
const run = async (...args: string[]) => (await git(args, { cwd: repo })).stdout;
const adopt = (unused: readonly { path: string; identity: string }[] = [], revalidate = vi.fn()) =>
  service.adoptWorktree(repo, 340, unused, revalidate);
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "foom-adopt-")));
  repo = join(root, "repo");
  remote = join(root, "remote.git");
  fixture = join(root, "state.json");
  await mkdir(repo);
  await run("init", "-b", "main");
  await run(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  );
  await run("branch", "child-one");
  await run("clone", "--bare", repo, remote);
  await run("branch", "-D", "child-one");
  await run("remote", "add", "origin", "https://github.com/o/r.git");
  await run("config", `url.${remote}.insteadOf`, "https://github.com/o/r.git");
  const script = join(root, "gh.cjs");
  await writeFile(script, FAKE_GH);
  await writeFile(fixture, "{}");
  service = new WorktreeService(join(root, "worktrees"), (url) =>
    forgeProvider(
      url,
      async (args) =>
        (
          await promisify(execFile)(process.execPath, [script, ...args], {
            env: { ...process.env, TEST_FORGE_STATE: fixture },
          })
        ).stdout,
    ),
  );
  await service.addRepository(repo);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it("adopts a remote-only PR head with the upstream used by plain push", async () => {
  const fork = join(root, "fork.git");
  await run("clone", "--bare", repo, fork);
  await run("remote", "add", "fork", fork);
  await run("config", "remote.pushDefault", "fork");
  const tree = await adopt();
  expect(tree.branch).toBe("child-one");
  expect(await service.launchIdentity(repo, tree.path)).toBe(tree.identity);
  expect(
    (await git(["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: tree.path })).stdout.trim(),
  ).toBe("origin/child-one");
  await git(
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "continue",
    ],
    { cwd: tree.path },
  );
  await git(["push"], { cwd: tree.path });
  expect((await git(["rev-parse", "refs/heads/child-one"], { cwd: remote })).stdout).toBe(
    (await git(["rev-parse", "HEAD"], { cwd: tree.path })).stdout,
  );
  await expect(adopt()).rejects.toThrow("branch_in_use");
  expect((await git(["rev-parse", "refs/heads/main"], { cwd: fork })).stdout).toBe(
    (await git(["rev-parse", "refs/heads/main"], { cwd: remote })).stdout,
  );
  await expect(
    git(["rev-parse", "--verify", "refs/heads/child-one"], { cwd: fork }),
  ).rejects.toThrow();
  await run("config", "branch.child-one.pushRemote", "fork");
  await expect(adopt([tree])).resolves.toEqual(tree);
  expect((await run("config", "--get", "branch.child-one.pushRemote")).trim()).toBe("origin");
});
it("preserves an existing local branch's commits while setting its PR upstream", async () => {
  await run("branch", "child-one");
  await run("config", "branch.child-one.pushRemote", "elsewhere");
  const tree = await adopt();
  expect((await run("config", "--get", "branch.child-one.pushRemote")).trim()).toBe("origin");
  expect(
    (await git(["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: tree.path })).stdout.trim(),
  ).toBe("origin/child-one");
});
it.each([
  [{ error: true }, "forge_unavailable"],
  [{ pr: { state: "CLOSED" } }, "pr_not_open"],
  [{ pr: { state: "MERGED" } }, "pr_not_open"],
  [{ pr: { isCrossRepository: true } }, "pr_from_fork"],
  [{ pr: { headRepositoryOwner: { login: "fork-owner" } } }, "pr_from_fork"],
  [{ pr: { headRefName: "main" } }, "default_branch"],
  [{ pr: { headRefName: "--help" } }, "invalid_branch"],
  [{ pr: { headRefName: "@{-1}" } }, "invalid_branch"],
  [{ pr: { headRefName: "bad..branch" } }, "invalid_branch"],
  [{ pr: { headRefName: "x".repeat(201) } }, "invalid_branch"],
  [{ pr: { headRefName: "bad\u202e" } }, "invalid_branch"],
  [{ pr: { headRefName: "HEAD" } }, "invalid_branch"],
  [{ pr: { headRepositoryOwner: null } }, "forge_unavailable"],
  [{ pr: { number: 99 } }, "forge_unavailable"],
])("refuses unsafe PR data %j with fixed reason %s", async (state, reason) => {
  await writeFile(fixture, JSON.stringify(state));
  await expect(adopt()).rejects.toThrow(reason);
  expect(await service.listWorktrees(repo)).toHaveLength(1);
  expect(await run("for-each-ref", "refs/remotes/origin/child-one")).toBe("");
});
it("refuses missing providers, missing origin and failed default discovery", async () => {
  await run("remote", "set-url", "origin", "https://gitlab.com/o/r");
  await expect(adopt()).rejects.toThrow("forge_unavailable");
  await run("remote", "remove", "origin");
  await expect(adopt()).rejects.toThrow("forge_unavailable");
  await run("remote", "add", "origin", "https://github.com/o/r.git");
  await rm(remote, { recursive: true, force: true });
  await expect(adopt()).rejects.toThrow("forge_unavailable");
});
it("refuses a missing remote default, external checkout and replaced ownership", async () => {
  await git(["symbolic-ref", "HEAD", "refs/heads/missing"], { cwd: remote });
  await expect(adopt()).rejects.toThrow("forge_unavailable");
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: remote });
  const external = join(root, "external");
  await run("worktree", "add", "-b", "child-one", external);
  await expect(adopt([{ path: external, identity: "forged" }])).rejects.toThrow("branch_in_use");
  await run("worktree", "remove", external);
  const tree = await adopt();
  await expect(adopt([{ ...tree, identity: "replaced" }])).rejects.toThrow("branch_in_use");
  await run("worktree", "lock", tree.path);
  await expect(adopt([tree])).rejects.toThrow("branch_in_use");
});
it("rechecks authority before mutation and after fetch, including reuse", async () => {
  const denied = vi.fn(() => {
    throw new Error("revoked");
  });
  await expect(adopt([], denied)).rejects.toThrow("revoked");
  expect(denied).toHaveBeenCalledOnce();
  const afterFetch = vi
    .fn()
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      throw new Error("revoked");
    });
  await expect(adopt([], afterFetch)).rejects.toThrow("revoked");
  expect(await service.listWorktrees(repo)).toHaveLength(1);
  const tree = await adopt();
  await expect(adopt([tree], denied)).rejects.toThrow("revoked");
});
it("does not create a scratch branch if the remote head vanished", async () => {
  await git(["update-ref", "-d", "refs/heads/child-one"], { cwd: remote });
  await expect(adopt()).rejects.toThrow();
  expect(await service.listWorktrees(repo)).toHaveLength(1);
});
it("charges uncertain creation after checkout or identity recording fails", async () => {
  vi.spyOn(service, "launchIdentity").mockRejectedValueOnce(new Error("identity failed"));
  await expect(adopt()).rejects.toBeInstanceOf(UncertainEffect);
});

it("refuses duplicate checked-out heads even if one checkout is owned and unused", async () => {
  const tree = await adopt();
  await run("worktree", "add", "--force", join(root, "duplicate"), "child-one");
  await expect(adopt([tree])).rejects.toThrow("branch_in_use");
});

it("uses the fixed in-use refusal when checkout identity cannot be revalidated", async () => {
  const tree = await adopt();
  const identity = vi.spyOn(service, "launchIdentity");
  identity.mockRejectedValueOnce(new Error("redirected"));
  await expect(adopt([tree])).rejects.toThrow("branch_in_use");
  identity.mockResolvedValueOnce(tree.identity).mockResolvedValueOnce("replaced-after-fetch");
  await expect(adopt([tree])).rejects.toThrow("branch_in_use");
});
