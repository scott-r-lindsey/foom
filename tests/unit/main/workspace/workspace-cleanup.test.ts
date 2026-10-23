import { expect, test, vi } from "vitest";
import { replaceConfigProviders } from "../../../../src/main/agents/providers/registry";
import { v2Provider } from "../../../../src/main/agents/providers/v2";
import { Workspace } from "../../../../src/main/workspace/workspace";
import { parseAgentManifest } from "../../../../src/shared/agent-plugin-parser";
import type { ConfirmWorkspace } from "../../../../src/shared/confirmation";
import pluginFixture from "../../../fixtures/agent-plugin.json";
import { bound, cleanupCommand, deps, launched, repo, tree } from "./workspace-fixture";

test("merged cleanup lists every skip rule and continues after a changed candidate", async () => {
  const workspace = new Workspace(deps);
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
      return Promise.resolve();
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
  expect((await workspace.sidebarInventory()).repositories[0]?.canDeleteMerged).toBe(false);
  await vi.waitFor(() => {
    expect(changed).toHaveBeenCalledTimes(2);
  });
  expect((await workspace.sidebarInventory()).repositories[0]?.canDeleteMerged).toBe(true);
  expect(deps.worktrees.mergedDefault).toHaveBeenCalledTimes(2);
  await workspace.dispose();
});

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

test("hidden finished cleanup reopens its retained results without another fetch", async () => {
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  const workspace = new Workspace(deps);
  const command = { kind: "delete-merged-worktrees", repository: repo.path } as const;
  await cleanupCommand(workspace, command, () => Promise.resolve(true));
  const fetches = vi.mocked(deps.worktrees.mergedDefault).mock.calls.length;
  await workspace.sidebarCommand(command, (request) => {
    if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing results");
    expect(request.feed.current().progress.phase).toBe("finished");
    expect(request.feed.current().progress.items[0]?.state).toBe("removed");
    return Promise.resolve(false);
  });
  expect(deps.worktrees.mergedDefault).toHaveBeenCalledTimes(fetches);
  await workspace.dispose();
});

test("cleanup retains branch reservations until the checked-ref transaction settles", async () => {
  vi.mocked(deps.worktrees.mergedCommit).mockResolvedValue(true);
  const workspace = new Workspace(deps);
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
