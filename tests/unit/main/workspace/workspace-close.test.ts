import { ENABLED_AGENTS } from "../../../helpers/enabled-agents";
import { expect, test, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import { readSessions } from "../../../../src/main/workspace/session-store";
import { agents, deps, held, launched, repo, tree } from "./workspace-fixture";

const close = { kind: "close", id: "t1" } as const;
const confirm = () => Promise.resolve(true);

test("accepted Close publishes before slow cleanup, blocks duplicate actions and checkout launch", async () => {
  const setClosing = vi.fn();
  deps.terminals.setClosing = setClosing;
  const workspace = await launched();
  await workspace.exited("t1", 0);
  const cleanup = held<undefined>();
  vi.spyOn(deps.terminals, "kill").mockReturnValue(cleanup.promise);
  const pending = workspace.sidebarCommand(close, confirm);
  expect(workspace.snapshot().terminals[0]?.closeState).toBe("closing");
  expect(setClosing).toHaveBeenCalledWith("t1", true);
  for (const kind of ["close", "new-conversation", "resume", "restart"] as const)
    await expect(workspace.sidebarCommand({ kind, id: "t1" }, confirm)).rejects.toThrow();
  await expect(
    workspace.sidebarCommand(
      { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
      confirm,
    ),
  ).rejects.toThrow("busy");
  await expect(
    workspace.sidebarCommand(
      { kind: "remove-worktree", repository: repo.path, worktree: tree.path },
      confirm,
    ),
  ).rejects.toThrow("busy");
  expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
  await workspace.sidebarInventory();
  expect(deps.worktrees.mergedCommit).not.toHaveBeenCalled();
  cleanup.resolve(undefined);
  await pending;
  expect(workspace.snapshot().terminals).toEqual([]);
  expect(setClosing).toHaveBeenLastCalledWith("t1", false);
  await workspace.dispose();
});

test("running and busy close refusals leave the row intact without cleanup", async () => {
  const workspace = await launched();
  await expect(workspace.sidebarCommand(close, confirm)).rejects.toThrow();
  expect(workspace.snapshot().terminals[0]?.closeState).toBeUndefined();
  expect(vi.spyOn(deps.terminals, "kill")).not.toHaveBeenCalled();
  await workspace.dispose();
});

test.each([true, false])(
  "dirty owned-close decision %s preserves trusted removal rules",
  async (accepted) => {
    const workspace = await launched();
    await workspace.exited("t1", 0);
    vi.mocked(deps.worktrees.reviewIdentity).mockReturnValue("identity");
    vi.mocked(deps.worktrees.changes).mockResolvedValue(" M tracked.txt");
    const decision = held<boolean>();
    deps.dialog = vi.fn(() => decision.promise);
    const removal = held<undefined>();
    vi.mocked(deps.worktrees.removeWorktree).mockReturnValue(removal.promise);
    const pending = workspace.sidebarCommand(close, confirm);
    expect(workspace.snapshot().terminals[0]?.closeState).toBe("closing");
    await vi.waitFor(() => {
      expect(deps.dialog).toHaveBeenCalled();
    });
    expect(deps.dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Remove review worktree?",
        accept: "Discard changes and remove",
      }),
      expect.any(AbortSignal),
    );
    decision.resolve(accepted);
    if (accepted) {
      await vi.waitFor(() => {
        expect(deps.worktrees.removeWorktree).toHaveBeenCalled();
      });
      expect(workspace.snapshot().terminals[0]?.closeState).toBe("closing");
    }
    removal.resolve(undefined);
    await pending;
    if (accepted) expect(workspace.snapshot().terminals).toEqual([]);
    else {
      expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
      expect(workspace.snapshot().terminals[0]?.closeState).toBeUndefined();
    }
    await workspace.dispose();
  },
);

test("cleanup failures restore and persist the row for retry", async () => {
  const save = vi.fn(() => Promise.resolve());
  deps.sessions = { load: () => Promise.resolve([]), save, flush: () => Promise.resolve() };
  const workspace = await launched();
  await workspace.exited("t1", 0);
  vi.spyOn(deps.terminals, "kill").mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(workspace.sidebarCommand(close, confirm)).rejects.toThrow("cleanup failed");
  expect(workspace.snapshot().terminals[0]?.closeState).toBe("failed");
  expect(save).toHaveBeenLastCalledWith([expect.objectContaining({ closeState: "failed" })]);
  await workspace.sidebarCommand(close, confirm);
  expect(workspace.snapshot().terminals).toEqual([]);
  await workspace.dispose();
});

test("quit persists in-flight Close and restart surfaces interrupted cleanup without relaunch", async () => {
  const saved: unknown[][] = [];
  deps.sessions = {
    load: () => Promise.resolve([]),
    save: (records) => {
      saved.push(structuredClone([...records]));
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
  };
  const workspace = await launched();
  await workspace.exited("t1", 0);
  const cleanup = held<undefined>();
  vi.spyOn(deps.terminals, "kill").mockReturnValue(cleanup.promise);
  const pending = workspace.sidebarCommand(close, confirm);
  await workspace.prepareQuit();
  const frozen = saved.at(-1);
  expect(frozen).toEqual([expect.objectContaining({ closeState: "closing", running: false })]);
  await workspace.dispose();
  cleanup.resolve(undefined);
  await pending;
  deps.sessions.load = () => Promise.resolve(readSessions(frozen));
  const restored = new Workspace(deps);
  restored.configure({ hooks: true, agents: ENABLED_AGENTS });
  await restored.restore();
  await restored.restartSaved();
  expect(restored.snapshot().terminals[0]).toMatchObject({
    id: "t1",
    closeState: "failed",
    dormant: true,
    exited: true,
  });
  await restored.dispose();
});

test("failed durable acceptance prevents cleanup and restores the row", async () => {
  const workspace = await launched();
  await workspace.exited("t1", 0);
  delete deps.sessions;
  await workspace.dispose();
  const save = vi.fn(() => Promise.reject(new Error("disk full")));
  deps.sessions = {
    load: () =>
      Promise.resolve(
        readSessions([
          {
            id: "t1",
            agent: "claude",
            repository: repo.path,
            worktree: tree.path,
            branch: tree.branch,
          },
        ]),
      ),
    save,
    flush: () => Promise.resolve(),
  };
  const restored = new Workspace(deps);
  restored.configure({ hooks: true, agents: ENABLED_AGENTS });
  await restored.restore();
  await expect(restored.sidebarCommand(close, confirm)).rejects.toThrow("disk full");
  expect(restored.snapshot().terminals[0]?.closeState).toBe("failed");
  expect(vi.spyOn(deps.terminals, "kill")).not.toHaveBeenCalled();
  await restored.dispose();
});

test("Close after quit freeze cannot overwrite saved running sessions", async () => {
  const workspace = await launched();
  await workspace.prepareQuit();
  await workspace.exited("t1", 0);
  await expect(workspace.sidebarCommand(close, confirm)).rejects.toThrow("quitting");
  expect(workspace.snapshot().terminals[0]?.closeState).toBeUndefined();
  expect(vi.spyOn(deps.terminals, "kill")).not.toHaveBeenCalled();
  workspace.cancelQuit();
  await workspace.sidebarCommand(close, confirm);
  await workspace.dispose();
});

test.each([
  { branch: "changed-branch", identity: "identity" },
  { branch: null, identity: "identity" },
  { branch: "changed-branch", identity: "replacement-identity" },
])(
  "Close holds the canonical checkout across inventory changes: %j",
  async ({ branch, identity }) => {
    const workspace = await launched();
    const create = vi
      .spyOn(deps.terminals, "create")
      .mockResolvedValueOnce("t2")
      .mockResolvedValueOnce("t3");
    await workspace.startWorktree(
      { repository: repo.path, branch: "feature", run: "shell" },
      confirm,
    );
    await workspace.exited("t1", 0);
    await workspace.exited("t2", 0);
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, branch }]);
    vi.mocked(deps.worktrees.launchIdentity).mockResolvedValue(identity);
    const cleanup = held<undefined>();
    const kill = vi.spyOn(deps.terminals, "kill").mockReturnValueOnce(cleanup.promise);
    const pending = workspace.sidebarCommand(close, confirm);
    try {
      await vi.waitFor(() => {
        expect(kill).toHaveBeenCalledOnce();
      });
      for (const run of ["shell", "claude"] as const)
        await expect(
          workspace.sidebarCommand(
            { kind: "launch", repository: repo.path, worktree: tree.path, run },
            confirm,
          ),
        ).rejects.toThrow("busy");
      await expect(
        workspace.launch(
          { agent: "claude", repository: repo.path, worktree: tree.path, cols: 80, rows: 24 },
          confirm,
        ),
      ).rejects.toThrow("busy");
      await expect(
        workspace.sidebarCommand({ kind: "restart", id: "t2" }, confirm),
      ).rejects.toThrow("busy");
      await expect(
        workspace.sidebarCommand(
          {
            kind: "resume-id",
            checkout: { repository: repo.path, worktree: tree.path },
            agent: "claude",
            id: "external-123",
          },
          confirm,
        ),
      ).rejects.toThrow("busy");
      if (branch !== null)
        await expect(
          workspace.startWorktree({ repository: repo.path, branch, run: "shell" }, confirm),
        ).rejects.toThrow("busy");
      expect(create).toHaveBeenCalledOnce();
      expect(kill).toHaveBeenCalledOnce();
    } finally {
      cleanup.resolve(undefined);
      await pending;
    }
    await workspace.sidebarCommand(
      { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
      confirm,
    );
    expect(create).toHaveBeenCalledTimes(2);
    await workspace.dispose();
  },
);

test("a preparing provider launch holds the canonical path against Close and removal", async () => {
  const workspace = await launched();
  await workspace.exited("t1", 0);
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
    { ...tree, branch: "changed-branch" },
  ]);
  const prepare = held<undefined>();
  const kill = vi.spyOn(deps.terminals, "kill");
  agents.launch.mockImplementationOnce(async (request) => {
    await prepare.promise;
    request.beforeSpawn?.();
    return { id: "prepared-child", attention: "evaluator" };
  });
  const launching = workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: tree.path, run: "claude" },
    confirm,
  );
  try {
    await vi.waitFor(() => {
      expect(agents.launch).toHaveBeenCalledTimes(2);
    });
    await expect(workspace.sidebarCommand(close, confirm)).rejects.toMatchObject({
      code: "session-busy",
    });
    await expect(
      workspace.sidebarCommand(
        { kind: "remove-worktree", repository: repo.path, worktree: tree.path },
        confirm,
      ),
    ).rejects.toThrow("busy");
    expect(workspace.snapshot().terminals[0]?.closeState).toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
  } finally {
    prepare.resolve(undefined);
    await launching;
  }
  expect(workspace.snapshot().terminals.some((row) => row.id === "prepared-child")).toBe(true);
  await workspace.sidebarCommand(close, confirm);
  await workspace.dispose();
});

test.each(["renamed", null])(
  "pending idle removal holds the path against Close after branch %s",
  async (branch) => {
    const workspace = await launched();
    await workspace.exited("t1", 0);
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, branch }]);
    const answer = held<boolean>();
    const confirmRemoval = vi.fn(() => answer.promise);
    const cleanup = held<undefined>();
    const kill = vi.spyOn(deps.terminals, "kill").mockReturnValueOnce(cleanup.promise);
    const removing = workspace.sidebarCommand(
      { kind: "remove-worktree", repository: repo.path, worktree: tree.path },
      confirmRemoval,
    );
    let closing: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => {
        expect(confirmRemoval).toHaveBeenCalledOnce();
      });
      vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
        { ...tree, branch: "changed-again" },
      ]);
      closing = workspace.sidebarCommand(close, confirm).catch((error: unknown) => error);
      expect(workspace.snapshot().terminals[0]?.closeState).toBeUndefined();
      expect(await closing).toMatchObject({ code: "session-busy" });
      await expect(
        workspace.sidebarCommand(
          { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
          confirm,
        ),
      ).rejects.toThrow("busy");
      expect(kill).not.toHaveBeenCalled();
      expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve(undefined);
      answer.resolve(false);
      await removing;
      await closing;
    }
    await workspace.sidebarCommand(close, confirm);
    expect(kill).toHaveBeenCalledOnce();
    await workspace.dispose();
  },
);

test("shared-agent startup confirmation holds the path against an exited sibling Close", async () => {
  const workspace = await launched();
  vi.spyOn(deps.terminals, "create").mockResolvedValueOnce("t2");
  await workspace.startWorktree(
    { repository: repo.path, branch: "feature", run: "shell" },
    confirm,
  );
  await workspace.exited("t2", 0);
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, branch: "renamed" }]);
  agents.launch.mockResolvedValueOnce({ id: "t3", attention: "evaluator" });
  const answer = held<boolean>();
  const shared = vi.fn(() => answer.promise);
  const started = vi.fn();
  const starting = workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: tree.path, run: "claude" },
    shared,
    { signal: new AbortController().signal, started },
  );
  try {
    await vi.waitFor(() => {
      expect(shared).toHaveBeenCalledOnce();
    });
    await expect(
      workspace.sidebarCommand({ kind: "close", id: "t2" }, confirm),
    ).rejects.toMatchObject({ code: "session-busy" });
    expect(
      workspace.snapshot().terminals.find((row) => row.id === "t2")?.closeState,
    ).toBeUndefined();
    expect(started).not.toHaveBeenCalled();
  } finally {
    answer.resolve(true);
    await starting;
  }
  expect(started).toHaveBeenCalledOnce();
  expect(workspace.snapshot().terminals.some((row) => row.id === "t3")).toBe(true);
  await workspace.sidebarCommand({ kind: "close", id: "t2" }, confirm);
  await workspace.dispose();
});

test.each(["renamed", null])(
  "retained review offer holds its path against Close with current branch %s",
  async (branch) => {
    const { ForgeTracking } = await import("../../../../src/main/control/forge-tracking");
    const directory = deps.agentPluginDirectory;
    if (!directory) throw new Error("Missing fixture");
    const forge = new ForgeTracking(
      directory,
      () => Promise.resolve(undefined),
      () => {},
    );
    deps.forge = forge;
    forge.setEnabled(true);
    vi.spyOn(forge, "sync").mockImplementation(() => {});
    vi.spyOn(forge, "readBoard").mockReturnValue({ number: 1115, state: "CLOSED", checks: null });
    const workspace = await launched();
    await workspace.exited("t1", 0);
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, branch }]);
    vi.mocked(deps.worktrees.reviewIdentity).mockReturnValue("identity");
    const answer = held<boolean>();
    deps.dialog = vi.fn(() => answer.promise);
    try {
      await workspace.sidebarInventory();
      await vi.waitFor(() => {
        expect(deps.dialog).toHaveBeenCalledOnce();
      });
      await expect(workspace.sidebarCommand(close, confirm)).rejects.toMatchObject({
        code: "session-busy",
      });
      expect(workspace.snapshot().terminals[0]?.closeState).toBeUndefined();
      expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
      answer.resolve(false);
      vi.mocked(deps.worktrees.reviewIdentity).mockReturnValue(undefined);
      await vi.waitFor(async () => {
        await workspace.sidebarCommand(close, confirm);
      });
      expect(workspace.snapshot().terminals).toEqual([]);
    } finally {
      answer.resolve(false);
      await workspace.dispose();
    }
  },
);

test.each(["renamed", null])(
  "retained review cleanup waits for ordinary Close with current branch %s",
  async (branch) => {
    const { ForgeTracking } = await import("../../../../src/main/control/forge-tracking");
    const directory = deps.agentPluginDirectory;
    if (!directory) throw new Error("Missing fixture");
    const forge = new ForgeTracking(
      directory,
      () => Promise.resolve(undefined),
      () => {},
    );
    deps.forge = forge;
    forge.setEnabled(true);
    vi.spyOn(forge, "sync").mockImplementation(() => {});
    vi.spyOn(forge, "readBoard").mockReturnValue({ number: 1115, state: "CLOSED", checks: null });
    const workspace = await launched();
    await workspace.exited("t1", 0);
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, branch }]);
    const cleanup = held<undefined>();
    const kill = vi.spyOn(deps.terminals, "kill").mockReturnValue(cleanup.promise);
    const pending = workspace.sidebarCommand(close, confirm);
    vi.mocked(deps.worktrees.reviewIdentity).mockReturnValue("identity");
    deps.dialog = vi.fn(() => Promise.resolve(false));
    try {
      await vi.waitFor(() => {
        expect(kill).toHaveBeenCalledOnce();
      });
      await workspace.sidebarInventory();
      expect(workspace.snapshot().terminals[0]?.closeState).toBe("closing");
      expect(deps.dialog).not.toHaveBeenCalled();
      expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
      cleanup.resolve(undefined);
      await pending;
      await workspace.sidebarInventory();
      await vi.waitFor(() => {
        expect(deps.dialog).toHaveBeenCalledOnce();
      });
      expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve(undefined);
      await pending;
      await workspace.dispose();
    }
  },
);
