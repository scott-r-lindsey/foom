import { expect, it, vi } from "vitest";
import { CleanupOwner } from "../../../../src/main/workspace/cleanup-owner";
import type { CleanupOwnerDependencies } from "../../../../src/main/workspace/cleanup-owner";
import type { CleanupFeed } from "../../../../src/shared/cleanup";
import type { ConfirmWorkspace } from "../../../../src/shared/confirmation";
import type { Worktree } from "../../../../src/shared/worktrees";
import type { WorkspaceTerminal } from "../../../../src/shared/workspace";

const repository = "/repo";
const tree = (branch = "feature", extra: Partial<Worktree> = {}): Worktree => ({
  path: `/trees/${branch}`,
  branch,
  head: "abc",
  bare: false,
  locked: false,
  prunable: false,
  managed: false,
  ...extra,
});
const row = (id = "session", extra: Partial<WorkspaceTerminal> = {}): WorkspaceTerminal => ({
  id,
  repository,
  worktree: tree().path,
  branch: "feature",
  agent: "shell",
  kind: "shell",
  attention: "evaluator",
  state: null,
  exited: true,
  ...extra,
});
const accept = () => Promise.resolve(true);
function fixture() {
  let trees = [tree()];
  let rows: WorkspaceTerminal[] = [];
  let closed = false;
  let time = 1000;
  const locks = new Set<string>();
  let repositoryReserved = false;
  const releaseRepository = vi.fn(() => {
    repositoryReserved = false;
  });
  const events: string[] = [];
  const worktrees = {
    changes: vi.fn<CleanupOwnerDependencies["worktrees"]["changes"]>(() => Promise.resolve("")),
    removalIdentity: vi.fn<CleanupOwnerDependencies["worktrees"]["removalIdentity"]>(() =>
      Promise.resolve("identity"),
    ),
    launchIdentity: vi.fn(() => Promise.resolve("identity")),
    removeWorktree: vi.fn<CleanupOwnerDependencies["worktrees"]["removeWorktree"]>(() => {
      events.push("remove");
      return Promise.resolve();
    }),
    removeRepository: vi.fn(async () => {}),
    mergedDefault: vi.fn(() => Promise.resolve("base")),
    mergedFetchTime: vi.fn(() => 500),
    mergedCommit: vi.fn<CleanupOwnerDependencies["worktrees"]["mergedCommit"]>(() =>
      Promise.resolve(true),
    ),
    deleteMergedBranches: vi.fn<CleanupOwnerDependencies["worktrees"]["deleteMergedBranches"]>(() =>
      Promise.resolve([]),
    ),
    canAutoRemove: vi.fn(() => Promise.resolve(true)),
  };
  const acquireWorktree = vi.fn((_repository: string, branch: string | null) => {
    const key = branch ?? "";
    if (locks.has(key)) throw new Error("This worktree is busy");
    locks.add(key);
  });
  const deps = {
    worktrees,
    inventory: vi.fn(() => Promise.resolve(trees)),
    known: vi.fn(),
    withRepository: <T>(_repository: string, work: () => Promise<T>) => work(),
    reserveRepositoryRemoval: vi.fn((_repository: string, validate: () => void) => {
      if (repositoryReserved) throw new Error("Repository is busy");
      validate();
      repositoryReserved = true;
      return releaseRepository;
    }),
    withWorktreeRemoval: async (
      ...[
        repository,
        worktree,
        branch,
        confirm,
        revalidate,
        retainBranchLock,
        autoApprove,
      ]: Parameters<CleanupOwnerDependencies["withWorktreeRemoval"]>
    ): Promise<boolean> => {
      acquireWorktree(repository, branch);
      let removed = false;
      try {
        removed = await owner.removeReservedTree(
          repository,
          worktree,
          branch,
          confirm,
          revalidate,
          autoApprove,
        );
        return removed;
      } finally {
        if (!retainBranchLock || !removed) deps.releaseWorktree(repository, branch);
      }
    },
    releaseWorktree: vi.fn((_repository: string, branch: string | null) => {
      locks.delete(branch ?? "");
    }),
    terminals: () => rows,
    running: vi.fn(() => false),
    exitCode: vi.fn<CleanupOwnerDependencies["exitCode"]>(() => 0),
    stop: vi.fn(() => {
      events.push("stop");
      return Promise.resolve();
    }),
    exited: vi.fn(() => {
      events.push("exit");
      return Promise.resolve();
    }),
    kill: vi.fn(() => {
      events.push("kill");
      return Promise.resolve();
    }),
    removed: vi.fn((id: string) => {
      events.push("forget");
      rows = rows.filter((entry) => entry.id !== id);
    }),
    prepareWorktreeRemoval: vi.fn(() => {
      events.push("prepare");
      return Promise.resolve(() => {
        events.push("release");
      });
    }),
    closed: () => closed,
    refresh: vi.fn(),
    onChange: vi.fn(),
    now: () => time,
  } satisfies CleanupOwnerDependencies;
  const owner = new CleanupOwner(deps);
  const inventory = () => owner.inventory(repository, trees);
  const scan = async () => {
    const calls = deps.onChange.mock.calls.length;
    inventory();
    await vi.waitFor(() => {
      expect(deps.onChange.mock.calls.length).toBeGreaterThan(calls);
    });
    return inventory();
  };
  const run = async (during?: (feed: CleanupFeed) => void | Promise<void>) => {
    await owner.deleteMerged(repository, async (request) => {
      if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing feed");
      const feed = request.feed;
      await vi.waitFor(() => {
        expect(feed.current().stage).not.toBe("checking");
      });
      // A dialog action arrives on a later event-loop turn, after plan publication.
      await new Promise<void>((resolve) => setImmediate(resolve));
      feed.act();
      await during?.(feed);
      return false; // Hide, retaining run results after workers finish.
    });
  };
  return {
    owner,
    acquireWorktree,
    releaseRepository,
    deps,
    worktrees,
    locks,
    events,
    inventory,
    scan,
    run,
    trees: (value: Worktree[]) => {
      trees = value;
    },
    rows: (value: WorkspaceTerminal[]) => {
      rows = value;
    },
    close: () => {
      closed = true;
    },
    advance: () => {
      time += 60_000;
    },
  };
}

it("stops exited terminal resources, removes Git worktree, then revokes capabilities; dormant rows need no PTY", async () => {
  const f = fixture();
  f.rows([row(), row("saved", { dormant: true })]);
  await expect(f.owner.removeIdleTree(repository, tree().path, "feature", accept)).resolves.toBe(
    true,
  );
  expect(f.events).toEqual([
    "stop",
    "exit",
    "prepare",
    "remove",
    "release",
    "kill",
    "forget",
    "forget",
  ]);
  expect(f.worktrees.removeWorktree).toHaveBeenCalledWith(
    repository,
    tree().path,
    false,
    "identity",
  );
  expect(f.locks.size).toBe(0);
});

it.each(["cancel", "dirty", "running", "stop", "prepare", "remove", "kill"] as const)(
  "retains rows and releases the shared branch lock after %s interruption",
  async (failure) => {
    const f = fixture();
    f.rows([row()]);
    const confirm = vi.fn(() => {
      if (failure === "dirty") f.worktrees.changes.mockResolvedValue("changed");
      if (failure === "running") f.deps.running.mockReturnValue(true);
      return Promise.resolve(failure !== "cancel");
    });
    if (failure === "stop") f.deps.stop.mockRejectedValueOnce(new Error("stop"));
    if (failure === "prepare")
      f.deps.prepareWorktreeRemoval.mockRejectedValueOnce(new Error("prepare"));
    if (failure === "remove") f.worktrees.removeWorktree.mockRejectedValueOnce(new Error("remove"));
    if (failure === "kill") f.deps.kill.mockRejectedValueOnce(new Error("kill"));
    const operation = f.owner.removeIdleTree(repository, tree().path, "feature", confirm);
    if (failure === "cancel") await expect(operation).resolves.toBe(false);
    else await expect(operation).rejects.toThrow();
    expect(f.locks.size).toBe(0);
    expect(f.deps.removed).not.toHaveBeenCalled();
    if (failure === "remove") expect(f.events).toContain("release");
    if (["cancel", "dirty", "running"].includes(failure))
      expect(f.deps.stop).not.toHaveBeenCalled();
  },
);

it("checks running/restoring sessions before confirmation and dirty status again after stopping", async () => {
  const f = fixture();
  f.rows([row()]);
  f.deps.running.mockReturnValue(true);
  await expect(f.owner.removeIdleTree(repository, tree().path, "feature", accept)).rejects.toThrow(
    "running",
  );
  expect(f.acquireWorktree).not.toHaveBeenCalled();
  f.deps.running.mockReturnValue(false);
  f.deps.stop.mockImplementationOnce(() => {
    f.worktrees.changes.mockResolvedValue("new file");
    return Promise.resolve();
  });
  await expect(f.owner.removeIdleTree(repository, tree().path, "feature", accept)).rejects.toThrow(
    "changes have changed",
  );
  expect(f.worktrees.removeWorktree).not.toHaveBeenCalled();
});

it("keeps shared branch reservations across confirmation and allows retry after rejection", async () => {
  const f = fixture();
  const answer = Promise.withResolvers<boolean>();
  const confirm = vi.fn(() => answer.promise);
  const first = f.owner.removeIdleTree(repository, tree().path, "feature", confirm);
  await vi.waitFor(() => {
    expect(confirm).toHaveBeenCalledOnce();
  });
  await expect(f.owner.removeIdleTree(repository, tree().path, "feature", accept)).rejects.toThrow(
    "busy",
  );
  answer.resolve(false);
  await first;
  await expect(f.owner.removeIdleTree(repository, tree().path, "feature", accept)).resolves.toBe(
    true,
  );
});

it("rechecks repository sessions around confirmation and clears eligibility only on successful forgetting", async () => {
  const f = fixture();
  await f.scan();
  f.rows([row()]);
  await expect(f.owner.removeRepository(repository)).rejects.toThrow("sessions first");
  f.rows([]);
  await f.owner.removeRepository(repository, () => Promise.resolve(false));
  expect(f.worktrees.removeRepository).not.toHaveBeenCalled();
  await expect(
    f.owner.removeRepository(repository, () => {
      f.rows([row()]);
      return Promise.resolve(true);
    }),
  ).rejects.toThrow("sessions first");
  f.rows([]);
  f.worktrees.removeRepository.mockRejectedValueOnce(new Error("storage"));
  await expect(f.owner.removeRepository(repository)).rejects.toThrow("storage");
  expect(f.inventory().canDeleteMerged).toBe(true);
  await f.owner.removeRepository(repository);
  expect(f.deps.refresh).toHaveBeenCalledOnce();
  expect(f.inventory().canDeleteMerged).toBe(false);
  await f.scan();
});

it.each(["missing", "main", "identity", "revoked", "running"] as const)(
  "refuses owned-worktree removal when %s",
  async (failure) => {
    const f = fixture();
    if (failure === "missing") f.trees([]);
    if (failure === "main") f.trees([tree("feature", { path: repository })]);
    if (failure === "identity") f.worktrees.launchIdentity.mockResolvedValue("replacement");
    if (failure === "running") {
      f.rows([row()]);
      f.deps.running.mockReturnValue(true);
    }
    await expect(
      f.owner.removeOwnedTree(
        repository,
        failure === "main" ? repository : tree().path,
        "identity",
        accept,
        () => {
          if (failure === "revoked") throw new Error("revoked");
        },
      ),
    ).rejects.toThrow();
    expect(f.worktrees.removeWorktree).not.toHaveBeenCalled();
    expect(f.locks.size).toBe(0);
  },
);

it.each(["disabled", "eligible", "ineligible", "policy changed", "dirty", "cancel"] as const)(
  "uses current automatic-removal policy (%s) and rechecks before deleting",
  async (mode) => {
    const f = fixture();
    f.owner.configure(mode !== "disabled");
    if (mode === "ineligible") f.worktrees.canAutoRemove.mockResolvedValue(false);
    if (mode === "policy changed")
      f.worktrees.canAutoRemove.mockImplementationOnce(() => {
        // Policy changes after automatic approval, requiring ordinary confirmation.
        f.worktrees.canAutoRemove.mockResolvedValue(false);
        return Promise.resolve(true);
      });
    if (mode === "dirty") f.worktrees.changes.mockResolvedValue("dirty");
    const confirm = vi.fn((_branch: string, _changes: string, _automatic?: boolean) =>
      Promise.resolve(mode !== "cancel"),
    );
    const result = await f.owner.removeOwnedTree(
      repository,
      tree().path,
      "identity",
      confirm,
      () => {},
    );
    expect(result).toBe(mode !== "cancel");
    expect(confirm.mock.calls[0]?.[2]).toBe(
      ["eligible", "policy changed", "cancel"].includes(mode),
    );
    if (mode === "policy changed")
      expect(confirm.mock.calls.map((call) => call[2])).toEqual([true, false]);
    if (mode === "dirty")
      expect(f.worktrees.removeWorktree).toHaveBeenCalledWith(
        repository,
        tree().path,
        true,
        "identity",
      );
    expect(f.locks.size).toBe(0);
  },
);

it("discovers eligibility without blocking inventory, shares scans, expires results, and reports errors", async () => {
  const f = fixture();
  const fetch = Promise.withResolvers<string>();
  f.worktrees.mergedDefault.mockReturnValueOnce(fetch.promise);
  expect(f.inventory().canDeleteMerged).toBe(false);
  expect(f.inventory().canDeleteMerged).toBe(false);
  expect(f.worktrees.mergedDefault).toHaveBeenCalledOnce();
  fetch.resolve("base");
  await vi.waitFor(() => {
    expect(f.inventory()).toMatchObject({ canDeleteMerged: true, mergedCount: 1 });
  });
  f.advance();
  f.worktrees.mergedDefault.mockRejectedValueOnce(new Error("offline"));
  expect((await f.scan()).mergedError).toBe("offline");
  expect(f.worktrees.mergedDefault).toHaveBeenCalledTimes(2);
});

it.each(["inventory", "main only", "repository removed", "shutdown"] as const)(
  "discards late scan publication after %s",
  async (change) => {
    const f = fixture();
    const fetch = Promise.withResolvers<string>();
    f.worktrees.mergedDefault.mockReturnValueOnce(fetch.promise);
    f.inventory();
    if (change === "inventory") {
      f.trees([tree("new")]);
      await f.scan();
    }
    if (change === "main only") {
      f.trees([tree("main", { path: repository })]);
      f.inventory();
    }
    if (change === "repository removed") await f.owner.removeRepository(repository);
    if (change === "shutdown") {
      f.close();
      await f.owner.dispose();
    }
    const calls = f.deps.onChange.mock.calls.length;
    fetch.resolve("base");
    await vi.waitFor(() => {
      expect(f.worktrees.mergedCommit).toHaveBeenCalled();
    });
    // Drain promise publication without an elapsed-time delay.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.deps.onChange).toHaveBeenCalledTimes(calls);
  },
);

it("plans fixed skip reasons for protected and unavailable checkouts", async () => {
  const f = fixture();
  f.trees([
    tree("main", { path: repository }),
    tree("bare", { bare: true }),
    tree("locked", { locked: true }),
    tree("prunable", { prunable: true }),
    tree("detached", { branch: null }),
    tree("running"),
    tree("resume"),
    tree("dirty"),
    tree("unmerged"),
    tree("status-error"),
    tree("identity-error"),
    tree("ok"),
  ]);
  f.rows([
    row("running", { worktree: tree("running").path }),
    row("resume", { worktree: tree("resume").path, kind: "agent", conversationId: "conversation" }),
  ]);
  f.deps.exitCode.mockImplementation((id) => (id === "running" ? undefined : 0));
  f.worktrees.changes.mockImplementation((_repo, path) =>
    path === tree("status-error").path
      ? Promise.reject(new Error("status"))
      : Promise.resolve(path === tree("dirty").path ? "dirty" : ""),
  );
  f.worktrees.mergedCommit.mockImplementation((_repo, candidate) =>
    Promise.resolve(candidate.branch !== "unmerged"),
  );
  f.worktrees.removalIdentity.mockImplementation((_repo, path) =>
    path === tree("identity-error").path
      ? Promise.reject(new Error("identity"))
      : Promise.resolve("identity"),
  );
  await f.scan();
  const confirm: ConfirmWorkspace = (request) => {
    if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing feed");
    expect(request.feed.current().progress.items.map((item) => item.reason)).toEqual([
      "main checkout",
      "main checkout",
      "unavailable",
      "unavailable",
      "unavailable",
      "running",
      "resumable conversation",
      "uncommitted changes",
      "not merged",
      "unavailable",
      "unavailable",
      undefined,
    ]);
    return Promise.resolve(false);
  };
  await f.owner.deleteMerged(repository, confirm);
  expect(f.worktrees.removeWorktree).not.toHaveBeenCalled();
});

it("reuses a fresh plan, fetches on approval, retains locks through branch deletion, and reopens hidden results", async () => {
  const f = fixture();
  await f.scan();
  const branches = Promise.withResolvers<readonly string[]>();
  f.worktrees.deleteMergedBranches.mockReturnValueOnce(branches.promise);
  const work = f.run(async () => {
    await vi.waitFor(() => {
      expect(f.worktrees.deleteMergedBranches).toHaveBeenCalledOnce();
    });
    expect(f.locks.has("feature")).toBe(true);
    expect(f.worktrees.mergedDefault).toHaveBeenCalledTimes(2); // background plus approval
    f.trees([]);
    expect(f.inventory().removedWorktrees).toMatchObject([{ branch: "feature", removed: true }]);
    expect(f.inventory().cleanup?.phase).toBe("remove");
    // Hide before the transaction finishes, preserving the completion checklist.
    setImmediate(() => {
      branches.resolve([]);
    });
  });
  await work;
  expect(f.locks.size).toBe(0);
  const fetches = f.worktrees.mergedDefault.mock.calls.length;
  await f.owner.deleteMerged(repository, (request) => {
    if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing feed");
    expect(request.feed.current().progress.phase).toBe("finished");
    return Promise.resolve(true);
  });
  expect(f.worktrees.mergedDefault).toHaveBeenCalledTimes(fetches);
  expect(f.inventory().cleanup).toBeUndefined();
});

it.each([
  "branch",
  "head",
  "missing",
  "identity",
  "running",
  "dirty",
  "unmerged",
  "remove",
  "branches",
] as const)(
  "revalidates approved plans and releases retained locks on %s failure",
  async (failure) => {
    const f = fixture();
    await f.scan();
    if (failure === "branch") f.trees([tree("other", { path: tree().path })]);
    if (failure === "head") f.trees([tree("feature", { head: "changed" })]);
    if (failure === "missing") f.trees([]);
    if (failure === "identity") f.worktrees.removalIdentity.mockResolvedValue("changed");
    if (failure === "running") {
      f.rows([row()]);
      f.deps.exitCode.mockReturnValue(undefined);
    }
    if (failure === "dirty") f.worktrees.changes.mockResolvedValue("dirty");
    if (failure === "unmerged") f.worktrees.mergedCommit.mockResolvedValue(false);
    if (failure === "remove") f.worktrees.removeWorktree.mockRejectedValueOnce(new Error("remove"));
    if (failure === "branches")
      f.worktrees.deleteMergedBranches.mockRejectedValueOnce(new Error("refs"));
    await f.run();
    const item = f.inventory().cleanup?.items[0];
    expect(item).toMatchObject(
      failure === "branches"
        ? { state: "removed", reason: "branch kept" }
        : failure === "remove"
          ? { state: "error", reason: "removal failed" }
          : { state: "kept" },
    );
    expect(f.locks.size).toBe(0);
  },
);

it("drains superseded scans before deletion, suppresses new scans while pending, and drains active runs at shutdown", async () => {
  const f = fixture();
  const old = Promise.withResolvers<string>();
  f.worktrees.mergedDefault.mockReturnValueOnce(old.promise);
  f.inventory();
  f.trees([tree("feature", { head: "new" })]);
  await f.scan();
  const remove = Promise.withResolvers<undefined>();
  f.worktrees.removeWorktree.mockReturnValueOnce(remove.promise);
  const work = f.run(async (feed) => {
    expect(feed.current().progress.phase).toBe("fetch");
    const fetches = f.worktrees.mergedDefault.mock.calls.length;
    f.advance();
    f.inventory();
    expect(f.worktrees.mergedDefault).toHaveBeenCalledTimes(fetches);
    await f.owner.deleteMerged(repository, (request) => {
      expect(request.kind === "merged-worktrees" && request.feed).toBe(feed);
      return Promise.resolve(false);
    });
    expect(f.worktrees.removeWorktree).not.toHaveBeenCalled();
    old.resolve("old");
    await vi.waitFor(() => {
      expect(f.worktrees.removeWorktree).toHaveBeenCalledOnce();
    });
    f.close();
    let disposed = false;
    const disposing = f.owner.dispose().then(() => {
      disposed = true;
    });
    expect(disposed).toBe(false);
    expect(feed.current().progress.stopped).toBe(true);
    remove.resolve(undefined);
    await disposing;
    expect(disposed).toBe(true);
  });
  await work;
  expect(f.inventory().cleanup).toBeUndefined();
  expect(f.locks.size).toBe(0);
});

it.each(["preparation", "approval"] as const)(
  "refuses cleanup after %s fetch failure",
  async (stage) => {
    const f = fixture();
    if (stage === "approval") await f.scan();
    f.worktrees.mergedDefault.mockRejectedValueOnce(new Error("offline"));
    await f.owner.deleteMerged(repository, async (request) => {
      if (request.kind !== "merged-worktrees" || !request.feed) throw new Error("Missing feed");
      await vi.waitFor(() => {
        expect(request.feed?.current().stage).not.toBe("checking");
      });
      return true;
    });
    expect(f.worktrees.removeWorktree).not.toHaveBeenCalled();
    expect(f.locks.size).toBe(0);
  },
);

it("holds repository reservation during confirmation and releases it after cancellation or failed persistence", async () => {
  const f = fixture();
  const answer = Promise.withResolvers<boolean>();
  const confirm = vi.fn(() => answer.promise);
  const first = f.owner.removeRepository(repository, confirm);
  await vi.waitFor(() => {
    expect(confirm).toHaveBeenCalledOnce();
  });
  await expect(f.owner.removeRepository(repository)).rejects.toThrow("busy");
  expect(f.releaseRepository).not.toHaveBeenCalled();
  answer.resolve(false);
  await first;
  expect(f.releaseRepository).toHaveBeenCalledOnce();
  f.worktrees.removeRepository.mockRejectedValueOnce(new Error("storage"));
  await expect(f.owner.removeRepository(repository)).rejects.toThrow("storage");
  expect(f.releaseRepository).toHaveBeenCalledTimes(2);
  await f.owner.removeRepository(repository);
  expect(f.releaseRepository).toHaveBeenCalledTimes(3);
});
