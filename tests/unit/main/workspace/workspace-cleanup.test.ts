import { ENABLED_AGENTS } from "../../../helpers/enabled-agents";
import { expect, test, vi } from "vitest";
import { replaceConfigProviders } from "../../../../src/main/agents/providers/registry";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import { Workspace } from "../../../../src/main/workspace/workspace";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import type { CleanupFeed } from "../../../../src/shared/cleanup";
import type { ConfirmWorkspace } from "../../../../src/shared/confirmation";
import pluginFixture from "../../../fixtures/agent-plugin.json";
import { cleanupReady } from "../../../helpers/cleanup-feed";
import { bound, cleanupCommand, deps, launched, repo, tree } from "./workspace-fixture";

test("eligibility review checks current checkout state without reserving the repository or fetching", async () => {
  const workspace = new Workspace(deps);
  const read = Promise.withResolvers<string>();
  vi.mocked(deps.worktrees.cleanupStatus).mockReturnValueOnce(read.promise);
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
    tree,
    { ...tree, path: "/trees/detached", branch: null, locked: true },
  ]);
  const review = workspace.reviewMergedWorktrees(repo.path);
  try {
    await vi.waitFor(() => {
      expect(deps.worktrees.cleanupStatus).toHaveBeenCalledOnce();
    });
    const decline = vi.fn(() => Promise.resolve(false));
    await workspace.removeRepository(repo.path, decline);
    expect(decline).toHaveBeenCalledOnce();
    expect(deps.worktrees.mergedDefault).not.toHaveBeenCalled();
    expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
  } finally {
    read.resolve("");
    expect((await review)?.worktrees).toMatchObject([
      { branch: tree.branch, reason: "eligible" },
      {
        branch: `detached · Detached at ${tree.head.slice(0, 7)}`,
        reason: "unavailable",
      },
    ]);
    await workspace.dispose();
  }
});

test("merged cleanup lists every skip rule and continues after a changed candidate", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  const other = (name: string) => ({ ...tree, path: `/trees/${name}`, branch: name });
  const changed = other("changed");
  const dirty = other("dirty");
  const external = { ...other("external"), managed: false };
  const main = { ...other("main"), path: repo.path };
  const locked = { ...other("locked"), locked: true };
  const detached = { ...other("detached"), branch: null };
  const prunable = { ...other("prunable"), prunable: true };
  const unmerged = other("unmerged");
  const unavailable = other("unavailable");
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
    tree,
    changed,
    dirty,
    external,
    main,
    locked,
    detached,
    prunable,
    unmerged,
    unavailable,
  ]);
  vi.mocked(deps.worktrees.changes).mockImplementation((_repo, path) => {
    if (path === unavailable.path) throw new Error("gone");
    return Promise.resolve(path === dirty.path ? " M file\0" : "");
  });
  vi.mocked(deps.worktrees.mergedCommit).mockImplementation((_repo, tree) =>
    Promise.resolve(tree.path !== unmerged.path),
  );
  await expect
    .poll(async () => (await workspace.sidebarInventory()).repositories[0]?.canDeleteMerged)
    .toBe(true);
  const confirm = vi.fn<ConfirmWorkspace>(() => {
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
      tree,
      external,
      { ...changed, head: "new" },
    ]);
    return Promise.resolve(true);
  });
  await expect(
    cleanupCommand(workspace, { kind: "delete-merged-worktrees", repository: repo.path }, confirm),
  ).resolves.toBeUndefined();
  expect(confirm).toHaveBeenCalledWith({
    kind: "merged-worktrees",
    worktrees: [
      { branch: "feature" },
      { branch: "changed" },
      { branch: "dirty", reason: "uncommitted changes" },
      { branch: "external" },
      { branch: "main", reason: "main checkout" },
      { branch: "locked", reason: "unavailable" },
      { branch: "detached · Detached at abc", reason: "unavailable" },
      { branch: "prunable", reason: "unavailable" },
      { branch: "unmerged", reason: "not merged" },
      { branch: "unavailable", reason: "unavailable" },
    ],
  });
  expect(vi.mocked(deps.worktrees.removeWorktree)).toHaveBeenCalledTimes(2);
  for (const candidate of [tree, external]) {
    expect(vi.mocked(deps.worktrees.removeWorktree)).toHaveBeenCalledWith(
      repo.path,
      candidate.path,
      false,
      "identity",
      expect.any(Function),
    );
    expect(deps.worktrees.deleteMergedBranches).toHaveBeenCalledWith(
      repo.path,
      expect.arrayContaining([{ branch: candidate.branch, head: candidate.head }]),
    );
  }
  await workspace.dispose();
});

test.each(["dirty", "unmerged", "replaced", "renamed", "missing"])(
  "merged cleanup revalidates %s after confirmation",
  async (change) => {
    const workspace = new Workspace(deps);
    workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
    vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
    await expect(
      cleanupCommand(
        workspace,
        { kind: "delete-merged-worktrees", repository: repo.path },
        async () => {
          if (change === "dirty") vi.mocked(deps.worktrees.changes).mockResolvedValue("?? file\0");
          if (change === "unmerged")
            vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(false);
          if (change === "replaced")
            vi.mocked(deps.worktrees.removalIdentity).mockResolvedValue("new");
          if (change === "renamed")
            vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
              { ...tree, branch: "other" },
            ]);
          if (change === "missing") vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([]);
          return Promise.resolve(true);
        },
      ),
    ).resolves.toBeUndefined();
    expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
    expect(deps.worktrees.deleteMergedBranch).not.toHaveBeenCalled();
    await workspace.dispose();
  },
);

test("merged cleanup cancels, refuses stale fetches and hides ineligible inventory", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  const command = { kind: "delete-merged-worktrees", repository: repo.path } as const;
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, path: repo.path }]);
  expect((await workspace.sidebarInventory()).repositories[0]?.canDeleteMerged).toBe(false);
  expect(deps.worktrees.mergedDefault).not.toHaveBeenCalled();
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([tree]);
  await expect(
    cleanupCommand(workspace, command, () => Promise.resolve(true)),
  ).resolves.toBeUndefined();
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  await cleanupCommand(workspace, command, () => Promise.resolve(false));
  expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
  await expect(
    cleanupCommand(workspace, command, () => {
      vi.mocked(deps.worktrees.mergedDefault).mockRejectedValue(new Error("fetch failed"));
      return Promise.resolve(true);
    }),
  ).resolves.toBeUndefined();
  expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
  await expect
    .poll(async () => (await workspace.sidebarInventory()).repositories[0]?.mergedError)
    .toBe("fetch failed");
  await workspace.dispose();
});

test.each(["claude", "agy"] as const)(
  "%s: merged cleanup protects running and resumable sessions and rechecks after stopping exited resources",
  async (agent) => {
    const workspace = await launched(agent);
    const spare = { ...tree, path: "/spare", branch: "spare" };
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([tree, spare]);
    vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
    const command = { kind: "delete-merged-worktrees", repository: repo.path } as const;
    const confirm = vi.fn<ConfirmWorkspace>(() => Promise.resolve(false));
    await cleanupCommand(workspace, command, confirm);
    expect(confirm).toHaveBeenLastCalledWith({
      kind: "merged-worktrees",
      worktrees: [{ branch: "feature", reason: "running" }, { branch: "spare" }],
    });
    await workspace.hook({
      terminalId: await bound(agent),
      action: "classify",
      signal: agent === "claude" ? "claude:Stop" : "agy:Stop",
      conversationId: "saved-123",
    });
    await workspace.exited("t1", 0);
    await cleanupCommand(workspace, command, confirm);
    expect(confirm).toHaveBeenLastCalledWith({
      kind: "merged-worktrees",
      worktrees: [{ branch: "feature", reason: "resumable conversation" }, { branch: "spare" }],
    });
    expect(vi.mocked(deps.terminals, true).stop.mock.calls).toHaveLength(0);
    await workspace.dispose();
  },
);

test.each(["unmerged", "dirty", "replaced", "commit", "branch"])(
  "merged cleanup refuses %s worktrees after exiting terminal resources",
  async (change) => {
    const workspace = await launched();
    await workspace.exited("t1", 0);
    vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
    vi.mocked(deps.terminals, true).stop.mockImplementation(() => {
      if (change === "unmerged") vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(false);
      if (change === "dirty") vi.mocked(deps.worktrees.changes).mockResolvedValue("?? file\0");
      if (change === "replaced") vi.mocked(deps.worktrees.removalIdentity).mockResolvedValue("new");
      if (change === "commit")
        vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, head: "new-head" }]);
      if (change === "branch")
        vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, branch: "other" }]);
      return Promise.resolve(true);
    });
    await expect(
      cleanupCommand(workspace, { kind: "delete-merged-worktrees", repository: repo.path }, () =>
        Promise.resolve(true),
      ),
    ).resolves.toBeUndefined();
    expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
    expect(deps.worktrees.deleteMergedBranch).not.toHaveBeenCalled();
    await workspace.dispose();
  },
);

test("a session launched during confirmation is skipped", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  await expect(
    cleanupCommand(
      workspace,
      { kind: "delete-merged-worktrees", repository: repo.path },
      async () => {
        await cleanupCommand(
          workspace,
          { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
          () => Promise.resolve(true),
        );
        return Promise.resolve(true);
      },
    ),
  ).resolves.toBeUndefined();
  expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
  await workspace.dispose();
});

test("local inventory and launches proceed while a remote check is pending; completion publishes once", async () => {
  let complete: (base: string) => void = () => undefined;
  const pending = new Promise<string>((resolve) => {
    complete = resolve;
  });
  vi.mocked(deps.worktrees.mergedDefault).mockReturnValue(pending);
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  const changed = vi.fn();
  deps.onChange = changed;
  let now = 0;
  deps.now = () => now;
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  const inventory = await workspace.sidebarInventory();
  expect(inventory.repositories).toEqual([{ ...repo, worktrees: [tree], canDeleteMerged: false }]);
  await workspace.sidebarInventory();
  expect(deps.worktrees.mergedDefault).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
  // A foreground shell launch is independent of the pending remote check.
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
    () => Promise.resolve(true),
  );
  expect(workspace.snapshot().terminals).toHaveLength(1);
  await workspace.exited("t1", 0);
  changed.mockClear();
  complete("base");
  await vi.waitFor(() => {
    expect(changed).toHaveBeenCalledOnce();
  });
  expect((await workspace.sidebarInventory()).repositories[0]?.canDeleteMerged).toBe(true);
  expect(deps.worktrees.mergedDefault).toHaveBeenCalledOnce();
  now = 60_001;
  expect((await workspace.sidebarInventory()).repositories[0]?.mergedCount).toBe(1);
  await vi.waitFor(() => {
    expect(changed).toHaveBeenCalledTimes(2);
  });
  expect((await workspace.sidebarInventory()).repositories[0]?.canDeleteMerged).toBe(true);
  expect(deps.worktrees.mergedDefault).toHaveBeenCalledTimes(2);
  await workspace.dispose();
});

test.each(["eligible", "failed"])(
  "a replacement scan keeps the last zero count until it reports %s",
  async (outcome) => {
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, locked: true }]);
    vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
    const workspace = new Workspace(deps);
    const inventory = async () => (await workspace.sidebarInventory()).repositories[0];
    await expect.poll(inventory).toMatchObject({ mergedCount: 0 });
    const replacement = Promise.withResolvers<string>();
    vi.mocked(deps.worktrees.mergedDefault).mockReturnValueOnce(replacement.promise);
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([tree]);
    try {
      expect(await inventory()).toMatchObject({ mergedCount: 0, canDeleteMerged: false });
    } finally {
      if (outcome === "eligible") replacement.resolve("new base");
      else replacement.reject(new Error("offline"));
    }
    try {
      if (outcome === "eligible") {
        await expect.poll(inventory).toMatchObject({ mergedCount: 1, canDeleteMerged: true });
      } else {
        await expect.poll(inventory).toMatchObject({ mergedError: "offline" });
        expect((await inventory())?.mergedCount).toBeUndefined();
      }
    } finally {
      await workspace.dispose();
    }
  },
);

test.each([new Error("offline"), "offline"])(
  "background fetch failures publish status without rejecting inventory: %s",
  async (error) => {
    let fail: (error: unknown) => void = () => undefined;
    vi.mocked(deps.worktrees.mergedDefault).mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const changed = vi.fn();
    deps.onChange = changed;
    const workspace = new Workspace(deps);
    workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
    expect((await workspace.sidebarInventory()).repositories[0]?.mergedError).toBeUndefined();
    fail(error);
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledOnce();
    });
    expect((await workspace.sidebarInventory()).repositories[0]).toMatchObject({
      canDeleteMerged: false,
      mergedError: "offline",
    });
    await workspace.sidebarInventory();
    expect(deps.worktrees.mergedDefault).toHaveBeenCalledOnce();
    await workspace.dispose();
  },
);

test.each(["new inventory", "main only", "removed", "disposed"])(
  "a pending eligibility result is discarded after %s",
  async (change) => {
    let complete: (base: string) => void = () => undefined;
    const pending = new Promise<string>((resolve) => {
      complete = resolve;
    });
    vi.mocked(deps.worktrees.mergedDefault).mockReturnValueOnce(pending);
    vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
    const changed = vi.fn();
    deps.onChange = changed;
    const workspace = new Workspace(deps);
    workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
    await workspace.sidebarInventory();
    if (change === "new inventory") {
      vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, head: "new" }]);
      vi.mocked(deps.worktrees.mergedDefault).mockRejectedValue(new Error("new fetch failed"));
      await workspace.sidebarInventory();
      await vi.waitFor(() => {
        expect(changed).toHaveBeenCalledOnce();
      });
    }
    if (change === "main only") {
      vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, path: repo.path }]);
      await workspace.sidebarInventory();
    }
    if (change === "removed") await workspace.removeRepository(repo.path);
    if (change === "disposed") await workspace.dispose();
    changed.mockClear();
    complete("base");
    // A sentinel after containment proves the discarded scan completed.
    await vi.waitFor(() => {
      expect(deps.worktrees.mergedCommit).toHaveBeenCalled();
    });
    expect(changed).not.toHaveBeenCalled();
    if (change === "new inventory")
      expect((await workspace.sidebarInventory()).repositories[0]?.mergedError).toBe(
        "new fetch failed",
      );
    if (change === "disposed")
      expect((await workspace.sidebarInventory()).repositories[0]?.canDeleteMerged).toBe(false);
    await workspace.dispose();
  },
);

test("one slow remote does not delay another repository's inventory or eligibility", async () => {
  const other = { path: "/other", name: "other" };
  vi.mocked(deps.worktrees.listRepositories).mockReturnValue([repo, other]);
  let complete: (base: string) => void = () => undefined;
  const pending = new Promise<string>((resolve) => {
    complete = resolve;
  });
  vi.mocked(deps.worktrees.mergedDefault).mockImplementation((repository) =>
    repository === repo.path ? pending : Promise.resolve("base"),
  );
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  expect((await workspace.sidebarInventory()).repositories).toHaveLength(2);
  await expect
    .poll(async () => (await workspace.sidebarInventory()).repositories[1]?.canDeleteMerged)
    .toBe(true);
  expect((await workspace.sidebarInventory()).repositories[0]?.canDeleteMerged).toBe(false);
  complete("base");
  await expect
    .poll(async () => (await workspace.sidebarInventory()).repositories[0]?.canDeleteMerged)
    .toBe(true);
  await workspace.dispose();
});

test("fresh cached plan opens without fetching, stale plan opens checking, and a second Delete reopens", async () => {
  let now = 0;
  deps.now = () => now;
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  await expect
    .poll(async () => (await workspace.sidebarInventory()).repositories[0]?.canDeleteMerged)
    .toBe(true);
  vi.mocked(deps.worktrees.mergedDefault).mockClear();
  const command = { kind: "delete-merged-worktrees", repository: repo.path } as const;
  await workspace.sidebarCommand(command, (request) => {
    if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing feed");
    expect(request.feed.current().stage).toBe("ready");
    expect(deps.worktrees.mergedDefault).not.toHaveBeenCalled();
    return Promise.resolve(false);
  });
  now = 60_001;
  let release: (base: string) => void = () => {};
  vi.mocked(deps.worktrees.mergedDefault).mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  let opened = false;
  const first = workspace.sidebarCommand(command, async (request) => {
    if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing feed");
    const feed = request.feed;
    expect(feed.current().stage).toBe("checking");
    expect(feed.current().fetchedAt).toBe(1000);
    opened = true;
    await workspace.sidebarCommand(command, (second) => {
      expect(second).toHaveProperty("feed", feed);
      return Promise.resolve(false);
    });
    return false;
  });
  expect(opened).toBe(true);
  release("base");
  await first;
  await workspace.dispose();
});

test("a canceled new cleanup preserves the hidden checklist and reopening it needs no fetch", async () => {
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  const command = { kind: "delete-merged-worktrees", repository: repo.path } as const;
  await cleanupCommand(workspace, command, () => Promise.resolve(true));
  const runId = (await workspace.sidebarInventory()).repositories[0]?.cleanup?.id;
  if (!runId) throw new Error("Missing run ID");
  await workspace.sidebarCommand(command, (request) => {
    if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing feed");
    expect(request.feed.current().stage).not.toBe("run");
    return Promise.resolve(false);
  });
  const fetches = vi.mocked(deps.worktrees.mergedDefault).mock.calls.length;
  await workspace.sidebarCommand({ ...command, kind: "open-merged-cleanup", runId }, (request) => {
    if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing results");
    expect(request.feed.current().progress.phase).toBe("finished");
    expect(request.feed.current().progress.items[0]?.state).toBe("removed");
    request.onCleanupResultsDismissed?.();
    return Promise.resolve(false);
  });
  expect(deps.worktrees.mergedDefault).toHaveBeenCalledTimes(fetches);
  await workspace.dispose();
});

test("canceling a new cleanup does not restore results dismissed on another board", async () => {
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  const workspace = new Workspace(deps);
  const command = { kind: "delete-merged-worktrees", repository: repo.path } as const;
  await cleanupCommand(workspace, command, () => Promise.resolve(true));
  const finished = (await workspace.sidebarInventory()).repositories[0]?.cleanup;
  expect(finished?.phase).toBe("finished");
  if (!finished?.id) throw new Error("Missing run ID");

  const dismiss = Promise.withResolvers<boolean>();
  const results = workspace.sidebarCommand(
    { ...command, kind: "open-merged-cleanup", runId: finished.id },
    (request) => {
      if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing results");
      expect(request.feed.current().progress.id).toBe(finished.id);
      return dismiss.promise.then((answer) => {
        request.onCleanupResultsDismissed?.();
        return answer;
      });
    },
  );
  await workspace.sidebarCommand(command, async (request) => {
    if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing feed");
    expect(request.feed.current().stage).not.toBe("run");
    expect(request.feed.current().progress.id).not.toBe(finished.id);
    dismiss.resolve(false);
    await results;
    return false;
  });
  expect((await workspace.sidebarInventory()).repositories[0]?.cleanup).toBeUndefined();
  await workspace.dispose();
});

test("canceling a queued results dialog preserves the previous checklist when a replacement is canceled", async () => {
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  const workspace = new Workspace(deps);
  const command = { kind: "delete-merged-worktrees", repository: repo.path } as const;
  const cancel = Promise.withResolvers<boolean>();
  try {
    await cleanupCommand(workspace, command, () => Promise.resolve(true));
    const old = (await workspace.sidebarInventory()).repositories[0]?.cleanup;
    if (!old?.id) throw new Error("Missing previous run");
    const queued = workspace.sidebarCommand(
      { ...command, kind: "open-merged-cleanup", runId: old.id },
      () => cancel.promise,
    );
    await workspace.sidebarCommand(command, async () => {
      // The second board has installed its run. The first board reloads before
      // the dialog queue reaches the results, so it never calls canPresent.
      cancel.resolve(false);
      await queued;
      return false;
    });
    expect((await workspace.sidebarInventory()).repositories[0]?.cleanup?.id).toBe(old.id);
  } finally {
    cancel.resolve(false);
    await workspace.dispose();
  }
});

test("a dismissed cleanup checklist cannot open a fresh deletion review from a stale board", async () => {
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  const workspace = new Workspace(deps);
  const command = { kind: "delete-merged-worktrees", repository: repo.path } as const;
  try {
    await cleanupCommand(workspace, command, () => Promise.resolve(true));
    const finished = (await workspace.sidebarInventory()).repositories[0]?.cleanup;
    expect(finished?.phase).toBe("finished");
    if (!finished?.id) throw new Error("Missing run ID");
    const open = { ...command, kind: "open-merged-cleanup", runId: finished.id } as const;
    await workspace.sidebarCommand(open, (request) => {
      if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing results");
      expect(request.feed.current().progress.phase).toBe("finished");
      request.onCleanupResultsDismissed?.();
      return Promise.resolve(false);
    });
    vi.mocked(deps.worktrees.mergedDefault).mockClear();
    const staleResults = vi.fn(() => Promise.resolve(false));
    await workspace.sidebarCommand(open, staleResults);
    expect(staleResults).not.toHaveBeenCalled();
    expect(deps.worktrees.mergedDefault).not.toHaveBeenCalled();
  } finally {
    await workspace.dispose();
  }
});

test("a stale checklist cannot switch to a replacement and a second Delete cannot approve it after cancellation", async () => {
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  const workspace = new Workspace(deps);
  const command = { kind: "delete-merged-worktrees", repository: repo.path } as const;
  await cleanupCommand(workspace, command, () => Promise.resolve(true));
  const finished = (await workspace.sidebarInventory()).repositories[0]?.cleanup;
  if (!finished?.id) throw new Error("Missing run ID");
  const replacement = Promise.withResolvers<CleanupFeed>();
  const cancel = Promise.withResolvers<boolean>();
  const next = workspace.sidebarCommand(command, (request) => {
    if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing feed");
    replacement.resolve(request.feed);
    return cancel.promise;
  });
  const feed = await replacement.promise;
  await cleanupReady(feed);
  const queued = Promise.withResolvers<CleanupFeed>();
  const close = Promise.withResolvers<boolean>();
  const results = workspace.sidebarCommand(command, (request) => {
    if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing feed");
    queued.resolve(request.feed);
    return close.promise;
  });
  try {
    const staleResults = vi.fn(() => Promise.resolve(false));
    await workspace.sidebarCommand(
      { ...command, kind: "open-merged-cleanup", runId: finished.id },
      staleResults,
    );
    const replacementId = feed.current().progress.id;
    if (!replacementId) throw new Error("Missing replacement run ID");
    await workspace.sidebarCommand(
      { ...command, kind: "open-merged-cleanup", runId: replacementId },
      staleResults,
    );
    expect(staleResults).not.toHaveBeenCalled();
    const staleFeed = await queued.promise;
    expect(staleFeed).toBe(feed);
    cancel.resolve(false);
    await next;
    expect((await workspace.sidebarInventory()).repositories[0]?.cleanup?.id).toBe(finished.id);
    await workspace.removeRepository(repo.path, () => Promise.resolve(false));
    vi.mocked(deps.worktrees.mergedDefault).mockClear();
    vi.mocked(deps.worktrees.removeWorktree).mockClear();
    staleFeed.act();
    await Promise.resolve();
    expect(deps.worktrees.mergedDefault).not.toHaveBeenCalled();
    expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
    expect(staleFeed.current().progress.phase).toBe("finished");
  } finally {
    cancel.resolve(false);
    close.resolve(false);
    await Promise.all([next, results]);
    await workspace.dispose();
  }
});

test("a replacement fetch failure before approval preserves the completed checklist", async () => {
  let now = 0;
  deps.now = () => now;
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  const workspace = new Workspace(deps);
  const command = { kind: "delete-merged-worktrees", repository: repo.path } as const;
  try {
    await expect
      .poll(async () => (await workspace.sidebarInventory()).repositories[0]?.canDeleteMerged)
      .toBe(true);
    await cleanupCommand(workspace, command, () => Promise.resolve(true));
    const finished = (await workspace.sidebarInventory()).repositories[0]?.cleanup;
    expect(finished?.phase).toBe("finished");
    now = 60_001;
    vi.mocked(deps.worktrees.mergedDefault).mockRejectedValue(new Error("Offline"));
    await workspace.sidebarCommand(command, async (request) => {
      if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing feed");
      const feed = request.feed;
      expect(feed.current().stage).toBe("checking");
      await expect.poll(() => feed.current().error).toBe("fetch failed");
      return false;
    });
    expect((await workspace.sidebarInventory()).repositories[0]?.cleanup?.id).toBe(finished?.id);
  } finally {
    await workspace.dispose();
  }
});

test("cleanup retains branch reservations until the checked-ref transaction settles", async () => {
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  vi.mocked(deps.worktrees.deleteMergedBranches).mockImplementation(async () => {
    await expect(workspace.createWorktree(repo.path, "feature")).rejects.toThrow("busy");
    throw new Error("ref lock failed");
  });
  await cleanupCommand(workspace, { kind: "delete-merged-worktrees", repository: repo.path }, () =>
    Promise.resolve(true),
  );
  await expect(workspace.createWorktree(repo.path, "feature")).resolves.toHaveProperty("path");
  await workspace.dispose();
});

test("cleanup drains superseded eligibility scans and does not rescan while removing", async () => {
  const releases: (() => void)[] = [];
  const changes = vi.mocked(deps.worktrees.changes);
  for (let index = 0; index < 2; index++) {
    changes.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releases.push(() => {
            resolve("");
          });
        }),
    );
  }
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  await workspace.sidebarInventory();
  await vi.waitFor(() => {
    expect(releases).toHaveLength(1);
  });
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, head: "new-head" }]);
  await workspace.sidebarInventory();
  await vi.waitFor(() => {
    expect(releases).toHaveLength(2);
  });
  let started = false;
  const cleanup = workspace.sidebarCommand(
    { kind: "delete-merged-worktrees", repository: repo.path },
    async (request) => {
      if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing feed");
      const feed = request.feed;
      await vi.waitFor(() => {
        expect(feed.current().stage).toBe("ready");
      });
      feed.act();
      started = true;
      return false; // Hide while the run waits for readers to finish.
    },
  );
  await vi.waitFor(() => {
    expect(started).toBe(true);
  });
  const scans = vi.mocked(deps.worktrees.mergedDefault).mock.calls.length;
  await workspace.sidebarInventory();
  expect(deps.worktrees.mergedDefault).toHaveBeenCalledTimes(scans);
  releases[1]?.();
  await vi.waitFor(() => {
    expect(deps.worktrees.mergedCommit).toHaveBeenCalledTimes(2);
  });
  expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
  vi.mocked(deps.worktrees.removeWorktree).mockImplementation(async () => {
    const before = vi.mocked(deps.worktrees.changes).mock.calls.length;
    // An inventory event caused by deletion must not start new Git readers.
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([]);
    await workspace.sidebarInventory();
    expect(deps.worktrees.changes).toHaveBeenCalledTimes(before);
  });
  releases[0]?.();
  await cleanup;
  expect(vi.mocked(deps.worktrees.removeWorktree)).toHaveBeenCalledOnce();
  await workspace.dispose();
});

test("an unavailable config plugin still protects its recorded conversation from merged cleanup", async () => {
  const manifest = parseAgentManifest(JSON.stringify(pluginFixture)).model;
  replaceConfigProviders([v2Provider(manifest, () => Promise.resolve())]);
  const workspace = await launched(manifest.id);
  try {
    await workspace.hook({
      terminalId: await bound(manifest.id),
      action: "classify",
      signal: `plugin:${manifest.id}:stop`,
      conversationId: "saved-plugin-conversation",
    });
    await workspace.exited("t1", 0);
    replaceConfigProviders([]);
    const spare = { ...tree, path: "/spare", branch: "spare" };
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([tree, spare]);
    vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
    const confirm = vi.fn<ConfirmWorkspace>(() => Promise.resolve(false));
    await cleanupCommand(
      workspace,
      { kind: "delete-merged-worktrees", repository: repo.path },
      confirm,
    );
    expect(confirm).toHaveBeenLastCalledWith({
      kind: "merged-worktrees",
      worktrees: [{ branch: "feature", reason: "resumable conversation" }, { branch: "spare" }],
    });
    expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
  } finally {
    replaceConfigProviders([]);
    await workspace.dispose();
  }
});

test("approved merged cleanup retries one pending removal without Git authorization or branch deletion", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
    { ...tree, branch: null, head: null, prunable: true, removalFailed: true },
  ]);
  await cleanupCommand(workspace, { kind: "delete-merged-worktrees", repository: repo.path }, () =>
    Promise.resolve(true),
  );
  expect(deps.worktrees.cleanupBrokenWorktree).toHaveBeenCalledExactlyOnceWith(
    repo.path,
    tree.path,
  );
  expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
  expect(deps.worktrees.removalIdentity).not.toHaveBeenCalled();
  expect(deps.worktrees.deleteMergedBranches).toHaveBeenCalledWith(repo.path, []);
  await workspace.dispose();
});
