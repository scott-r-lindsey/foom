import { expect, test, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import type { Launched } from "./workspace-fixture";
import {
  agents,
  deps,
  launchEntries,
  repo,
  start,
  startRepositoryOperation,
  tails,
  tree,
} from "./workspace-fixture";

test("manual removal protects restoring sessions, but dormant exited sessions can be cleared", async () => {
  const stored = {
    id: "t1",
    kind: "shell" as const,
    agent: "shell" as const,
    repository: repo.path,
    worktree: tree.path,
    branch: tree.branch,
    attention: "evaluator" as const,
    state: null,
    dormant: true,
    exited: true,
    running: true,
  };
  deps.sessions = {
    load: () => Promise.resolve([stored]),
    save: async () => {},
    flush: async () => {},
  };
  const workspace = new Workspace(deps);
  await workspace.restore();
  const launching = Promise.withResolvers<string>();
  vi.spyOn(deps.terminals, "create").mockReturnValue(launching.promise);
  const restarting = workspace.restartSaved();
  const confirm = vi.fn(() => Promise.resolve(true));
  await expect(workspace.removeWorktree("t1", confirm)).rejects.toThrow(
    "A session is running in this worktree",
  );
  await expect(
    workspace.sidebarCommand(
      { kind: "remove-worktree", repository: repo.path, worktree: tree.path },
      confirm,
    ),
  ).rejects.toThrow("A session is running in this worktree");
  expect(confirm).not.toHaveBeenCalled();
  expect(vi.spyOn(deps.terminals, "stop")).not.toHaveBeenCalled();
  expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalled();
  });
  launching.reject(new Error("restore failed"));
  await restarting;
  expect(await workspace.removeWorktree("t1", confirm)).toBe(true);
  expect(workspace.snapshot().terminals).toEqual([]);
  await workspace.dispose();
});

test("cancelled or stale dirty-file confirmations never kill or remove", async () => {
  const workspace = new Workspace(deps);
  await workspace.startWorktree(start);
  await workspace.exited("t1", 0);
  const dirty = " M file.ts\0?? notes.txt\0";
  vi.spyOn(deps.worktrees, "changes").mockResolvedValue(dirty);
  const confirm = vi.fn(() => Promise.resolve(false));
  expect(await workspace.removeWorktree("t1", confirm)).toBe(false);
  expect(confirm).toHaveBeenCalledWith("feature", dirty);
  vi.spyOn(deps.worktrees, "changes")
    .mockResolvedValueOnce(dirty)
    .mockResolvedValueOnce("?? new.txt\0");
  await expect(workspace.removeWorktree("t1", () => Promise.resolve(true))).rejects.toThrow(
    "Review them",
  );
  expect(vi.spyOn(deps.terminals, "kill")).not.toHaveBeenCalled();
  expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
  await workspace.dispose();
});

test.each(["", "?? file.txt\0"])(
  "confirmed removal clears the exited terminal and removes only its owned worktree (%s)",
  async (changes) => {
    const workspace = new Workspace(deps);
    await workspace.startWorktree(start);
    await workspace.exited("t1", 0);
    vi.spyOn(deps.worktrees, "changes").mockResolvedValue(changes);
    expect(await workspace.removeWorktree("t1", () => Promise.resolve(true))).toBe(true);
    expect(vi.spyOn(deps.terminals, "kill")).toHaveBeenCalledWith("t1");
    expect(vi.mocked(deps.worktrees.removeWorktree)).toHaveBeenCalledWith(
      repo.path,
      tree.path,
      changes.length > 0,
      "identity",
      expect.any(Function),
    );
    expect(workspace.snapshot().terminals).toEqual([]);
    await expect(workspace.removeWorktree("t1", () => Promise.resolve(true))).rejects.toThrow(
      "Unknown",
    );
    await workspace.dispose();
  },
);

test("failed removal leaves the row available for retry and excludes overlapping operations", async () => {
  const workspace = new Workspace(deps);
  await workspace.startWorktree(start);
  await workspace.exited("t1", 0);
  const confirmation = Promise.withResolvers<boolean>();
  const removing = workspace.removeWorktree("t1", () => confirmation.promise);
  await expect(workspace.removeWorktree("t1", () => Promise.resolve(true))).rejects.toThrow("busy");
  await expect(workspace.startWorktree(start)).rejects.toThrow("busy");
  vi.spyOn(deps.worktrees, "removeWorktree").mockRejectedValueOnce(new Error("filesystem busy"));
  confirmation.resolve(true);
  await expect(removing).rejects.toThrow("filesystem busy");
  expect(workspace.snapshot().terminals).toHaveLength(1);
  await workspace.removeWorktree("t1", () => Promise.resolve(true));
  expect(workspace.snapshot().terminals).toHaveLength(0);
  await workspace.dispose();
});

test.each(["", "?? reviewed.txt\0"])(
  "shutdown changes require fresh review and permit retry (%s)",
  async (changes) => {
    const workspace = new Workspace(deps);
    await workspace.startWorktree(start);
    await workspace.exited("t1", 0);
    const changed = changes + "?? NEW-AFTER-CONFIRM.txt\0";
    vi.spyOn(deps.worktrees, "changes").mockResolvedValue(changes);
    const shutdown = Promise.withResolvers<undefined>();
    const stop = vi.spyOn(deps.terminals, "stop").mockImplementationOnce(async () => {
      await shutdown.promise;
      vi.spyOn(deps.worktrees, "changes").mockResolvedValue(changed);
    });
    const removal = workspace.removeWorktree("t1", () => Promise.resolve(true));
    const rejected = expect(removal).rejects.toThrow("Review them");
    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalled();
    });
    expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
    shutdown.resolve(undefined);
    await rejected;
    expect(vi.spyOn(deps.terminals, "kill")).not.toHaveBeenCalled();
    expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
    expect(workspace.snapshot().terminals).toHaveLength(1);
    expect(workspace.snapshot().terminals[0]?.state?.state).toBe("done");
    const confirm = vi.fn(() => Promise.resolve(true));
    await workspace.removeWorktree("t1", confirm);
    expect(confirm).toHaveBeenCalledWith("feature", changed);
    expect(workspace.snapshot().terminals).toHaveLength(0);
    await workspace.dispose();
  },
);

test.each(launchEntries)(
  "repository removal blocks %s through confirmation and deregistration",
  async (entry) => {
    const workspace = new Workspace(deps);
    const answer = Promise.withResolvers<boolean>();
    const deleted = Promise.withResolvers<undefined>();
    vi.mocked(deps.worktrees.removeRepository).mockReturnValue(deleted.promise);
    const removing = workspace.sidebarCommand(
      { kind: "remove-repository", repository: repo.path },
      () => answer.promise,
    );
    await expect(startRepositoryOperation(workspace, entry)).rejects.toThrow(
      "removal is in progress",
    );
    await expect(workspace.removeRepository(repo.path)).rejects.toThrow("busy");
    answer.resolve(true);
    await vi.waitFor(() => {
      expect(vi.mocked(deps.worktrees.removeRepository)).toHaveBeenCalledOnce();
    });
    await expect(startRepositoryOperation(workspace, entry)).rejects.toThrow(
      "removal is in progress",
    );
    expect(vi.spyOn(deps.terminals, "create")).not.toHaveBeenCalled();
    expect(agents.launch).not.toHaveBeenCalled();
    vi.mocked(deps.worktrees.listRepositories).mockReturnValue([]);
    deleted.resolve(undefined);
    await removing;
    await expect(startRepositoryOperation(workspace, entry)).rejects.toThrow("not been added");
    expect(workspace.snapshot().terminals).toEqual([]);
  },
);

test.each(launchEntries)(
  "an in-flight %s reserves its repository before the terminal exists",
  async (entry) => {
    const workspace = new Workspace(deps);
    const listing = Promise.withResolvers<readonly (typeof tree)[]>();
    vi.mocked(deps.worktrees.listWorktrees).mockReturnValue(listing.promise);
    const starting = startRepositoryOperation(workspace, entry);
    await vi.waitFor(() => {
      expect(deps.worktrees.listWorktrees).toHaveBeenCalled();
    });
    const confirm = vi.fn(() => Promise.resolve(true));
    await expect(
      workspace.sidebarCommand({ kind: "remove-repository", repository: repo.path }, confirm),
    ).rejects.toThrow("busy");
    await expect(workspace.removeRepository(repo.path)).rejects.toThrow("busy");
    expect(confirm).not.toHaveBeenCalled();
    expect(deps.worktrees.removeRepository).not.toHaveBeenCalled();
    listing.resolve([tree, { ...tree, path: repo.path, managed: false }]);
    await starting;
    if (entry !== "create-worktree") {
      await expect(workspace.removeRepository(repo.path)).rejects.toThrow("Close");
      await workspace.exited("t1", 0);
      await expect(workspace.removeRepository(repo.path)).rejects.toThrow("Close");
      workspace.removed("t1");
    }
    await workspace.removeRepository(repo.path);
    expect(vi.mocked(deps.worktrees.removeRepository)).toHaveBeenCalledOnce();
  },
);

test("repository reservations are scoped and release after cancellation, confirmation failure and write failure", async () => {
  const workspace = new Workspace(deps);
  const answer = Promise.withResolvers<boolean>();
  const other = { path: "/repos/other", name: "other" };
  vi.mocked(deps.worktrees.listRepositories).mockReturnValue([repo, other]);
  const removing = workspace.removeRepository(repo.path, () => answer.promise);
  await workspace.launch({
    agent: "claude",
    repository: other.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
  });
  answer.resolve(false);
  await removing;
  expect(deps.worktrees.removeRepository).not.toHaveBeenCalled();
  await expect(
    workspace.removeRepository(repo.path, () => Promise.reject(new Error("dialog"))),
  ).rejects.toThrow("dialog");
  vi.mocked(deps.worktrees.removeRepository).mockRejectedValueOnce(new Error("write"));
  await expect(workspace.removeRepository(repo.path)).rejects.toThrow("write");
  await workspace.removeRepository(repo.path);
  await workspace.dispose();
  await expect(workspace.removeRepository(repo.path)).rejects.toThrow("closed");
});

test("failed and overlapping launches retain the reservation until the last operation settles", async () => {
  const workspace = new Workspace(deps);
  const first = Promise.withResolvers<Launched>();
  const second = Promise.withResolvers<Launched>();
  agents.launch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
    tree,
    { ...tree, path: "/second", branch: "second" },
  ]);
  const a = startRepositoryOperation(workspace, "agent-ipc");
  const b = workspace.launch({
    agent: "claude",
    repository: repo.path,
    worktree: "/second",
    cols: 80,
    rows: 24,
  });
  await vi.waitFor(() => {
    expect(agents.launch).toHaveBeenCalledTimes(2);
  });
  const failed = expect(a).rejects.toThrow("spawn");
  first.reject(new Error("spawn"));
  await failed;
  await expect(workspace.removeRepository(repo.path)).rejects.toThrow("busy");
  const alsoFailed = expect(b).rejects.toThrow("spawn");
  second.reject(new Error("spawn"));
  await alsoFailed;
  await workspace.removeRepository(repo.path);
  expect(vi.mocked(deps.worktrees.removeRepository)).toHaveBeenCalledOnce();
});

test("repository removal cannot pass while a main-checkout shell is still spawning", async () => {
  const workspace = new Workspace(deps);
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
    { ...tree, path: repo.path, managed: false },
  ]);
  const spawned = Promise.withResolvers<string>();
  const create = vi.spyOn(deps.terminals, "create").mockReturnValueOnce(spawned.promise);
  const starting = startRepositoryOperation(workspace, "sidebar-shell");
  await vi.waitFor(() => {
    expect(create).toHaveBeenCalledOnce();
  });
  await expect(workspace.removeRepository(repo.path)).rejects.toThrow("busy");
  expect(workspace.snapshot().terminals).toEqual([]);
  spawned.resolve("t1");
  await starting;
  await expect(workspace.removeRepository(repo.path)).rejects.toThrow("Close");
  expect(vi.mocked(deps.worktrees.removeRepository)).not.toHaveBeenCalled();
  expect(workspace.snapshot().terminals[0]?.repository).toBe(repo.path);
});

test.each(["shell", "claude", "codex", "agy"] as const)(
  "sidebar launches %s in an external checkout without adopting it",
  async (run) => {
    const workspace = new Workspace(deps);
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
      { ...tree, managed: false, branch: null },
    ]);
    await workspace.sidebarCommand(
      { kind: "launch", repository: repo.path, worktree: tree.path, run },
      () => Promise.resolve(true),
    );
    expect(deps.worktrees.launchIdentity).toHaveBeenCalledWith(repo.path, tree.path);
    if (run === "shell")
      expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: tree.path }),
      );
    else
      expect(agents.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          worktree: tree.path,
          checkoutIdentity: "identity",
          mainCheckout: false,
          sharedCheckout: true,
        }),
      );
    expect(workspace.snapshot().terminals[0]).toMatchObject({ worktree: tree.path, branch: null });
    expect(deps.worktrees.createWorktree).not.toHaveBeenCalled();
  },
);

test("a checkout replaced before shell creation is refused and remains retryable", async () => {
  const workspace = new Workspace(deps);
  vi.mocked(deps.worktrees.launchIdentity)
    .mockResolvedValueOnce("old")
    .mockResolvedValueOnce("new");
  const command = {
    kind: "launch",
    repository: repo.path,
    worktree: tree.path,
    run: "shell",
  } as const;
  await expect(workspace.sidebarCommand(command, () => Promise.resolve(true))).rejects.toThrow(
    "Worktree has changed",
  );
  expect(vi.spyOn(deps.terminals, "create")).not.toHaveBeenCalled();
  await workspace.sidebarCommand(command, () => Promise.resolve(true));
  expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledOnce();
});

test.each(["sidebar", "dialog", "agent-ipc"] as const)(
  "%s warns only for another live agent, supports cancellation and allows shells",
  async (entry) => {
    const workspace = new Workspace(deps);
    const confirm = vi.fn(() => Promise.resolve(false));
    vi.spyOn(deps.terminals, "create")
      .mockResolvedValueOnce("s1")
      .mockResolvedValueOnce("s2")
      .mockResolvedValueOnce("s3");
    await workspace.startWorktree(start, confirm);
    await workspace.sidebarCommand(
      { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
      confirm,
    );
    expect(confirm).not.toHaveBeenCalled();
    let next = 0;
    agents.launch.mockImplementation(() =>
      Promise.resolve({
        id: `a${String(++next)}`,
        attention: "hooks",
      }),
    );
    const launch = () =>
      entry === "sidebar"
        ? workspace.sidebarCommand(
            { kind: "launch", repository: repo.path, worktree: tree.path, run: "claude" },
            confirm,
          )
        : entry === "dialog"
          ? workspace.startWorktree({ ...start, run: "claude" }, confirm)
          : workspace.launch(
              { agent: "claude", repository: repo.path, worktree: tree.path, cols: 80, rows: 24 },
              confirm,
            );
    await launch();
    expect(confirm).not.toHaveBeenCalled();
    await launch();
    expect(confirm).toHaveBeenCalledWith({ kind: "shared-agent" });
    expect(agents.launch).toHaveBeenCalledTimes(1);
    confirm.mockResolvedValue(true);
    await launch();
    expect(agents.launch).toHaveBeenCalledTimes(2);
    expect(agents.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ sharedCheckout: true }),
    );
    confirm.mockClear();
    await workspace.sidebarCommand(
      { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
      confirm,
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(workspace.snapshot().terminals).toHaveLength(5);
    tails.set("a1", []);
    tails.set("a2", []);
    await workspace.exited("a1", 0);
    await workspace.exited("a2", 0);
    await launch();
    expect(confirm).not.toHaveBeenCalled();
    expect(agents.launch).toHaveBeenCalledTimes(3);
  },
);

test("simultaneous legacy launches cannot bypass the active-agent warning", async () => {
  const workspace = new Workspace(deps);
  const pending = Promise.withResolvers<Launched>();
  agents.launch.mockReturnValueOnce(pending.promise);
  const request = {
    agent: "claude",
    repository: repo.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
  } as const;
  const first = workspace.launch(request);
  await vi.waitFor(() => {
    expect(agents.launch).toHaveBeenCalledOnce();
  });
  await expect(workspace.launch(request)).rejects.toThrow("busy");
  pending.resolve({ id: "a1", attention: "hooks" });
  await first;
  expect(await workspace.launch(request)).toBeNull();
  expect(agents.launch).toHaveBeenCalledOnce();
  expect(await workspace.startWorktree({ ...start, run: "claude" })).toBeNull();
});

test("removing a shared worktree clears all exited sessions before the final status check and removal", async () => {
  const workspace = new Workspace(deps);
  vi.spyOn(deps.terminals, "create").mockResolvedValueOnce("s1").mockResolvedValueOnce("s2");
  await workspace.startWorktree(start);
  await workspace.startWorktree(start);
  agents.launch.mockResolvedValueOnce({ id: "a1", attention: "hooks" });
  await workspace.startWorktree({ ...start, run: "claude" });
  const stopped: string[] = [];
  vi.spyOn(deps.terminals, "stop").mockImplementation((id) => {
    stopped.push(id);
    return Promise.resolve();
  });
  for (const id of ["s1", "s2", "a1"]) {
    tails.set(id, []);
    await workspace.exited(id, 0);
  }
  vi.mocked(deps.worktrees.changes)
    .mockResolvedValueOnce("")
    .mockResolvedValueOnce("")
    .mockImplementation(() => {
      expect(stopped).toEqual(["s1", "s2", "a1"]);
      return Promise.resolve("");
    });
  await workspace.removeWorktree("s1", () => Promise.resolve(true));
  expect(vi.spyOn(deps.terminals, "kill").mock.calls.map(([id]) => id)).toEqual(["s1", "s2", "a1"]);
  expect(workspace.snapshot().terminals).toEqual([]);
});

test.each([false, true])(
  "worktree removal releases preview resources before Git and unlocks after failure=%s",
  async (fails) => {
    const order: string[] = [];
    deps.prepareWorktreeRemoval = vi.fn((worktree) => {
      expect(worktree).toBe(tree.path);
      order.push("close previews");
      return Promise.resolve(() => {
        order.push("unlock");
      });
    });
    vi.mocked(deps.worktrees.removeWorktree).mockImplementation(() => {
      order.push("git remove");
      return fails ? Promise.reject(new Error("Git failed")) : Promise.resolve();
    });
    const workspace = new Workspace(deps);
    await workspace.startWorktree(start);
    await workspace.exited("t1", 0);
    expect(await workspace.removeWorktree("t1", () => Promise.resolve(false))).toBe(false);
    expect(order).toEqual([]);
    const removal = workspace.removeWorktree("t1", () => Promise.resolve(true));
    if (fails) await expect(removal).rejects.toThrow("Git failed");
    else expect(await removal).toBe(true);
    expect(order).toEqual(["close previews", "git remove", "unlock"]);
  },
);
