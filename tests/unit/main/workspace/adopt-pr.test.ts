import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { git, gitSync } from "../../../helpers/git.js";
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

it.each([false, true])("adopts only fast-forwardable local branches (reuse=%s)", async (reuse) => {
  await run("branch", "child-one");
  const owned = reuse ? await adopt() : undefined;
  const unused = owned ? [owned] : [];
  const initial = (await run("rev-parse", "child-one")).trim();
  const commit = async (parent: string, message: string) =>
    (
      await run(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=t@example.com",
        "commit-tree",
        "HEAD^{tree}",
        "-p",
        parent,
        "-m",
        message,
      )
    ).trim();
  await writeFile(join(repo, "remote.txt"), "remote update\n");
  await run("add", "remote.txt");
  await run(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-m",
    "remote files",
  );
  const target = await commit(initial, "remote advance");
  await run("push", "origin", `${target}:refs/heads/child-one`);
  const tree = await adopt(unused);
  if (owned) expect(tree).toEqual(owned);
  expect((await git(["rev-parse", "HEAD"], { cwd: tree.path })).stdout.trim()).toBe(target);
  expect((await run("rev-parse", "child-one")).trim()).toBe(target);
  expect(await readFile(join(tree.path, "remote.txt"), "utf8")).toBe("remote update\n");
  expect((await git(["status", "--porcelain"], { cwd: tree.path })).stdout).toBe("");

  // Equality succeeds without changing the checkout or its identity.
  if (!reuse) await run("worktree", "remove", tree.path);
  const equal = await adopt(reuse ? [tree] : []);
  if (reuse) expect(equal).toEqual(tree);
  expect((await git(["rev-parse", "HEAD"], { cwd: equal.path })).stdout.trim()).toBe(target);

  // Both ahead-only and truly divergent histories preserve all local commits.
  const local = await commit(target, "local advance");
  await git(["update-ref", "refs/heads/child-one", local], { cwd: equal.path });
  if (!reuse) await run("worktree", "remove", equal.path);
  const count = (await service.listWorktrees(repo)).length;
  await expect(adopt(reuse ? [equal] : [])).rejects.toThrow("branch_diverged");
  const divergent = await commit(target, "another remote advance");
  await run("push", "origin", `${divergent}:refs/heads/child-one`);
  await expect(adopt(reuse ? [equal] : [])).rejects.toThrow("branch_diverged");
  expect((await run("rev-parse", "child-one")).trim()).toBe(local);
  expect(await service.listWorktrees(repo)).toHaveLength(count);
});

it.each([false, true])(
  "rechecks authority immediately before fast-forward (reuse=%s)",
  async (reuse) => {
    await run("branch", "child-one");
    const owned = reuse ? await adopt() : undefined;
    await run(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "advance",
    );
    await run("push", "origin", "main:child-one");
    const before = await run("rev-parse", "child-one");
    const revalidate = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("revoked before fast-forward");
      });
    await expect(adopt(owned ? [owned] : [], revalidate)).rejects.toThrow(
      "revoked before fast-forward",
    );
    expect(await run("rev-parse", "child-one")).toBe(before);
  },
);

it.each(["external", "switched", "replaced"])(
  "refuses checkout changes before a fast-forward (%s)",
  async (change) => {
    await run("branch", "child-one");
    const tree = await adopt();
    await run(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "advance",
    );
    await run("push", "origin", "main:child-one");
    const before = await run("rev-parse", "child-one");
    const original = service.launchIdentity.bind(service);
    const identity = vi.spyOn(service, "launchIdentity");
    identity.mockImplementationOnce(original).mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      if (change === "external")
        await run("worktree", "add", "--force", join(root, "external"), "child-one");
      else if (change === "switched") await git(["switch", "-c", "other"], { cwd: tree.path });
      else identity.mockResolvedValueOnce("replacement");
      return result;
    });
    await expect(adopt([tree])).rejects.toThrow("branch_in_use");
    expect(await run("rev-parse", "child-one")).toBe(before);
  },
);

it("never advances a branch checked out elsewhere immediately before the ref update", async () => {
  await run("branch", "child-one");
  const before = await run("rev-parse", "child-one");
  await run(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "advance",
  );
  await run("push", "origin", "main:child-one");
  const external = join(root, "external");
  const revalidate = vi
    .fn()
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => undefined)
    .mockImplementationOnce(() => {
      gitSync(["worktree", "add", external, "child-one"], { cwd: repo, stdio: "pipe" });
    });
  await expect(adopt([], revalidate)).rejects.toThrow();
  expect(await run("rev-parse", "child-one")).toBe(before);
  expect((await git(["rev-parse", "HEAD"], { cwd: external })).stdout).toBe(before);
  expect((await git(["status", "--porcelain"], { cwd: external })).stdout).toBe("");
});
