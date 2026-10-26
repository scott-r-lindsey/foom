import { writeFileSync } from "node:fs";
import { UncertainEffect } from "../../../../src/main/workspace/worktree-outcome";
import { CleanupOwner } from "../../../../src/main/workspace/cleanup-owner";
import type { CleanupOwnerDependencies } from "../../../../src/main/workspace/cleanup-owner";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorktreeService } from "../../../../src/main/workspace/worktrees";
import { git, gitSync } from "../../../helpers/git.js";
import { nativeDeadline } from "../../../helpers/native-test-policy";
import { createWorktreeFixture } from "./worktree-git-fixture";

vi.setConfig({ testTimeout: nativeDeadline(10000), hookTimeout: nativeDeadline(10000) });
const fixtures = createWorktreeFixture();
let repo: string;
let root: string;
let temporary: string;
let service: WorktreeService;
let path: string;
let identity: string;
let head: string;
const run = async (cwd: string, ...args: string[]) => (await git(args, { cwd })).stdout.trim();
const commit = (cwd: string) =>
  run(
    cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--allow-empty",
    "-am",
    "test",
  );
const eligible = () => service.canAutoRemoveReview(repo, path, identity);
beforeEach(
  fixtures.usingFixture(async () => {
    ({ repo, root, temporary } = await fixtures.create());
    await writeFile(join(repo, "tracked"), "initial\n");
    await run(repo, "add", "tracked");
    await commit(repo);
    await run(repo, "branch", "feature");
    await run(repo, "clone", "--bare", repo, join(temporary, "remote.git"));
    await run(repo, "remote", "add", "origin", join(temporary, "remote.git"));
    service = await WorktreeService.open(join(temporary, "profile"), root, [], () => ({
      resolve: () => Promise.resolve({ branch: "feature", sameRepository: true, state: "OPEN" }),
      lookup: () => Promise.resolve(undefined),
    }));
    await service.addRepository(repo);
    await service.createWorktree(repo, "feature");
    const review = await service.adoptWorktree(repo, 843, [], vi.fn(), "root", true);
    ({ path, identity } = review);
    head = await run(path, "rev-parse", "HEAD");
  }),
);
afterEach(() => fixtures.cleanup());

it(
  "reviews an occupied PR branch without creating any branch or retaining a fetch ref",
  fixtures.usingFixture(async () => {
    expect(await eligible()).toBe(true);
    expect(await run(repo, "branch", "--format=%(refname)")).toBe(
      "refs/heads/feature\nrefs/heads/main",
    );
    expect(await run(repo, "for-each-ref", "refs/foom-review-fetch")).toBe("");
    const trees = await service.listWorktrees(repo);
    expect(trees.find((tree) => tree.path === path)).toMatchObject({ branch: null, head });
    await expect(service.adoptWorktree(repo, 843, [], vi.fn())).rejects.toThrow("branch_in_use");
    await service.removeWorktree(repo, path, false, identity);
    expect(await run(repo, "branch", "--format=%(refname)")).toBe(
      "refs/heads/feature\nrefs/heads/main",
    );
  }),
);

it(
  "persists the captured review head and local ref baseline",
  fixtures.usingFixture(async () => {
    const restarted = await WorktreeService.open(join(temporary, "profile"), root);
    expect(restarted.reviewIdentity(repo, path)).toBe(identity);
    expect(await restarted.canAutoRemoveReview(repo, path, identity)).toBe(true);
  }),
);

it.each([
  "tracked",
  "untracked",
  "ignored",
  "index-hidden",
  "attached",
  "moved-head",
  "reset-commit",
  "pushed-reset",
  "new-ref",
  "custom-ref",
  "root-ref",
  "private-ref",
  "git-operation",
  "git-lock",
  "logging-disabled",
  "missing-log",
  "broken-log",
  "missing-object",
  "wrong-identity",
  "missing-record",
  "replaced",
])("refuses automatic deletion: %s", async (mode) => {
  await fixtures.usingFixture(async () => {
    const admin = await run(path, "rev-parse", "--absolute-git-dir");
    switch (mode) {
      case "tracked":
        await writeFile(join(path, "tracked"), "changed");
        break;
      case "untracked":
        await writeFile(join(path, "new"), "keep");
        break;
      case "ignored":
        await run(repo, "config", "core.excludesFile", join(temporary, "ignore"));
        await writeFile(join(temporary, "ignore"), "ignored\n");
        await writeFile(join(path, "ignored"), "keep");
        break;
      case "index-hidden":
        await run(path, "update-index", "--assume-unchanged", "tracked");
        await writeFile(join(path, "tracked"), "hidden");
        break;
      case "attached":
        await run(path, "checkout", "-b", "reviewer-branch");
        break;
      case "moved-head":
        await commit(path);
        break;
      case "reset-commit":
        await commit(path);
        await run(path, "reset", "--hard", head);
        break;
      case "pushed-reset":
        await commit(path);
        await run(path, "push", "origin", "HEAD:refs/heads/reviewer-pushed");
        await run(path, "reset", "--hard", head);
        break;
      case "new-ref":
      case "root-ref":
      case "custom-ref":
      case "private-ref": {
        await commit(path);
        const unique = await run(path, "rev-parse", "HEAD");
        await run(path, "reset", "--hard", head);
        await run(path, "reflog", "expire", "--expire=now", "--all");
        await rm(join(admin, "ORIG_HEAD"), { force: true });
        await rm(join(admin, "COMMIT_EDITMSG"), { force: true });
        // Restore a valid baseline HEAD log, isolating protection of the new ref.
        await writeFile(
          join(admin, "logs", "HEAD"),
          `${head} ${head} Test <t@example.com> 1 +0000\ttest\n`,
        );
        await run(
          path,
          "update-ref",
          mode === "new-ref"
            ? "refs/heads/reviewer-work"
            : mode === "custom-ref"
              ? "refs/custom/reviewer-work"
              : mode === "root-ref"
                ? "ORIG_HEAD"
                : "refs/worktree/reviewer-work",
          unique,
        );
        break;
      }
      case "git-lock":
        await writeFile(join(admin, "index.lock"), "");
        break;
      case "git-operation":
        await mkdir(join(admin, "rebase-merge"));
        break;
      case "logging-disabled":
        await run(repo, "config", "core.logAllRefUpdates", "false");
        break;
      case "missing-log":
        await rm(join(admin, "logs", "HEAD"));
        break;
      case "broken-log":
        await writeFile(join(admin, "logs", "HEAD"), "invalid\n");
        break;
      case "missing-object":
        await writeFile(
          join(admin, "logs", "HEAD"),
          `${"a".repeat(40)} ${head} Test <t@example.com> 1 +0000\ttest\n`,
        );
        break;
      case "wrong-identity":
        identity = "different";
        break;
      case "missing-record":
        service = new WorktreeService(root);
        await service.addRepository(repo);
        break;
      case "replaced":
        await rename(join(path, ".git"), join(path, ".git-old"));
        await writeFile(join(path, ".git"), await readFile(join(path, ".git-old")));
        break;
    }
    const ownerDeps: CleanupOwnerDependencies = {
      worktrees: service,
      inventory: (repository) => service.listWorktrees(repository),
      known: () => {},
      withRepository: (_repository, work) => work(),
      reserveRepositoryRemoval: () => () => {},
      withWorktreeRemoval: (...args) =>
        owner.removeReservedTree(args[0], args[1], args[2], args[3], args[4], args[6], args[7]),
      terminals: () => [],
      running: () => false,
      exitCode: () => 0,
      stop: async () => {},
      exited: async () => {},
      kill: async () => {},
      removed: () => {},
      closed: () => false,
      refresh: () => {},
      now: () => 0,
    };
    const owner = new CleanupOwner(ownerDeps);
    const confirmation = vi.fn(() => Promise.resolve(false));
    await owner.removeOwnedTree(repo, path, identity, confirmation, () => {}).catch(() => false);
    expect(confirmation).toHaveBeenCalled();
    // A failed proof cannot authorize removal. Unsafe identities/history still
    // refuse even with consent; declining any fallback preserves all data.
    expect(await readFile(join(path, "tracked"), "utf8")).toBe(
      mode === "tracked" || mode === "index-hidden"
        ? mode === "tracked"
          ? "changed"
          : "hidden"
        : "initial\n",
    );
    expect(await eligible()).toBe(false);
  })();
});

it(
  "does not grant review deletion to an ordinary detached checkout",
  fixtures.usingFixture(async () => {
    const ordinary = await service.createWorktree(repo, "ordinary");
    await run(ordinary.path, "checkout", "--detach");
    expect(service.reviewIdentity(repo, ordinary.path)).toBeUndefined();
    expect(
      await service.canAutoRemoveReview(
        repo,
        ordinary.path,
        await service.launchIdentity(repo, ordinary.path),
      ),
    ).toBe(false);
  }),
);

it("maps only the recorded detached head to its source PR branch", () => {
  expect(service.reviewBranch(repo, path, head)).toBe("feature");
  expect(service.reviewBranch(repo, path, "0".repeat(40))).toBeUndefined();
  expect(service.reviewBranch(repo, repo, head)).toBeUndefined();
});

it.each([
  null,
  {},
  { head: "invalid", branch: "feature", refs: "" },
  { head: "a".repeat(40), branch: "-unsafe", refs: "" },
  { head: "a".repeat(40), branch: "feature", refs: 42 },
])("drops malformed saved review provenance: %j", async (review) => {
  await fixtures.usingFixture(async () => {
    const file = join(temporary, "profile", "worktrees.json");
    const state: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      !state ||
      typeof state !== "object" ||
      !("managed" in state) ||
      !Array.isArray(state.managed)
    )
      throw new Error("Invalid fixture state");
    const managed: unknown[] = state.managed;
    for (const entry of managed) {
      if (entry && typeof entry === "object" && "path" in entry && entry.path === path)
        Object.assign(entry, { review });
    }
    await writeFile(file, JSON.stringify(state));
    const restarted = await WorktreeService.open(join(temporary, "profile"), root);
    expect(restarted.reviewIdentity(repo, path)).toBeUndefined();
    expect(await restarted.canAutoRemoveReview(repo, path, identity)).toBe(false);
  })();
});

it(
  "drops its private fetch ref when authority changes before creation",
  fixtures.usingFixture(async () => {
    const before = await service.listWorktrees(repo);
    const revalidate = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("authority changed");
      });
    await expect(service.adoptWorktree(repo, 843, [], revalidate, "root", true)).rejects.toThrow(
      "authority changed",
    );
    expect(await service.listWorktrees(repo)).toEqual(before);
    expect(await run(repo, "for-each-ref", "refs/foom-review-fetch")).toBe("");
  }),
);

it(
  "reports uncertain review creation without leaving a branch or temporary fetch ref",
  fixtures.usingFixture(async () => {
    const create = service.createWorktree.bind(service);
    vi.spyOn(service, "createWorktree").mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error("creation response lost");
    });
    await expect(service.adoptWorktree(repo, 843, [], vi.fn(), "root", true)).rejects.toThrow();
    expect((await service.listWorktrees(repo)).filter((tree) => tree.branch === null)).toHaveLength(
      2,
    );
    expect(await run(repo, "branch", "--format=%(refname)")).toBe(
      "refs/heads/feature\nrefs/heads/main",
    );
    expect(await run(repo, "for-each-ref", "refs/foom-review-fetch")).toBe("");
  }),
);

it.each([
  { detachedHead: "-unsafe" },
  { detachedHead: "a".repeat(40), newBranch: true },
  { detachedHead: "a".repeat(40), trackOrigin: true },
])("rejects invalid internal detached creation options: %j", async (options) => {
  await fixtures.usingFixture(async () => {
    await expect(service.createWorktree(repo, "invalid-review", options)).rejects.toThrow(
      "Invalid detached creation",
    );
  })();
});

it(
  "keeps unrelated pre-existing local refs from blocking a clean review",
  fixtures.usingFixture(async () => {
    // The main checkout can have work newer than the PR; that shared history is
    // retained by its own refs and is not part of the review checkout being removed.
    await commit(repo);
    const review = await service.adoptWorktree(repo, 843, [], vi.fn(), "root", true);
    expect(await run(repo, "rev-parse", "HEAD")).not.toBe(head);
    expect(await service.canAutoRemoveReview(repo, review.path, review.identity)).toBe(true);
  }),
);

it.each(["before-creation", "after-creation"])(
  "failed fetch-ref cleanup preserves uncertainty: %s",
  async (mode) => {
    await fixtures.usingFixture(async () => {
      const blockFetchRef = () => {
        const options = { cwd: repo, encoding: "utf8" as const };
        const ref = gitSync(
          ["for-each-ref", "--format=%(refname)", "refs/foom-review-fetch"],
          options,
        )
          .toString()
          .trim();
        const lock = gitSync(
          ["rev-parse", "--path-format=absolute", "--git-path", `${ref}.lock`],
          options,
        )
          .toString()
          .trim();
        writeFileSync(lock, "fixture lock", { flag: "wx" });
      };
      const create = service.createWorktree.bind(service);
      if (mode === "after-creation")
        vi.spyOn(service, "createWorktree").mockImplementationOnce(async (...args) => {
          const result = await create(...args);
          blockFetchRef();
          return result;
        });
      let validations = 0;
      const pending = service.adoptWorktree(
        repo,
        843,
        [],
        () => {
          validations++;
          if (mode === "before-creation" && validations === 2) {
            blockFetchRef();
            throw new Error("Authority ended before creation");
          }
        },
        "root",
        true,
      );
      if (mode === "after-creation") await expect(pending).rejects.toBeInstanceOf(UncertainEffect);
      else await expect(pending).rejects.not.toBeInstanceOf(UncertainEffect);
      expect(await service.listWorktrees(repo)).toHaveLength(mode === "after-creation" ? 4 : 3);
      expect(await run(repo, "for-each-ref", "refs/foom-review-fetch")).not.toBe("");
      expect(await run(repo, "branch", "--format=%(refname)")).toBe(
        "refs/heads/feature\nrefs/heads/main",
      );
    })();
  },
);
