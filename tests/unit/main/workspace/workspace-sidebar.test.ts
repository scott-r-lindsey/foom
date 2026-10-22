import { expect, test, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import { agents, deps, launched, repo, scan, start, tree } from "./workspace-fixture";

test("sidebar inventory includes empty trees and the actual shell; launches use registered location identities", async () => {
  const workspace = new Workspace(deps);
  vi.stubEnv("SHELL", "/bin/zsh");
  expect(await workspace.sidebarInventory()).toMatchObject({
    repositories: [{ ...repo, worktrees: [tree], canDeleteMerged: false }],
    shell: process.platform === "win32" ? "powershell.exe" : "zsh",
  });
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
    () => Promise.resolve(true),
  );
  expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: tree.path,
      args: process.platform === "win32" ? ["-NoLogo"] : ["-l"],
    }),
  );
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: tree.path, run: "claude" },
    () => Promise.resolve(true),
  );
  await expect(
    workspace.sidebarCommand(
      { kind: "launch", repository: "/foreign", worktree: tree.path, run: "shell" },
      () => Promise.resolve(true),
    ),
  ).rejects.toThrow("not been added");
  await expect(
    workspace.sidebarCommand(
      { kind: "launch", repository: repo.path, worktree: "/foreign", run: "shell" },
      () => Promise.resolve(true),
    ),
  ).rejects.toThrow("Worktree was removed");
  for (const unavailable of [
    { ...tree, locked: true },
    { ...tree, bare: true },
    { ...tree, prunable: true },
  ]) {
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([unavailable]);
    await expect(
      workspace.sidebarCommand(
        { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
        () => Promise.resolve(true),
      ),
    ).rejects.toThrow("unavailable");
  }
  vi.unstubAllEnvs();
});

test("main checkout supports shells and confirms a second agent; cancellation creates nothing", async () => {
  const workspace = new Workspace(deps);
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
    { ...tree, path: repo.path, managed: false },
  ]);
  const command = {
    kind: "launch",
    repository: repo.path,
    worktree: repo.path,
    run: "claude",
  } as const;
  const confirm = vi.fn(() => Promise.resolve(false));
  await workspace.sidebarCommand(command, confirm);
  expect(confirm).not.toHaveBeenCalled();
  expect(agents.launch).toHaveBeenCalledWith(
    expect.objectContaining({ mainCheckout: true, sharedCheckout: true }),
  );
  await workspace.sidebarCommand(command, confirm);
  expect(confirm).toHaveBeenCalledWith({ kind: "shared-agent" });
  expect(agents.launch).toHaveBeenCalledTimes(1);
  confirm.mockResolvedValue(true);
  agents.launch.mockResolvedValue({ id: "t2", attention: "hooks" });
  await workspace.sidebarCommand(command, confirm);
  expect(workspace.snapshot().terminals).toHaveLength(2);
  vi.spyOn(deps.terminals, "create").mockResolvedValue("shell");
  await workspace.sidebarCommand({ ...command, run: "shell" }, confirm);
  expect(workspace.snapshot().terminals).toHaveLength(3);
});

test("sidebar Codex launches start without notifier consent", async () => {
  const workspace = new Workspace(deps);
  agents.scan.mockResolvedValue({
    ...scan,
    agents: [
      { id: "codex", path: "/bin/codex", hooks: true, version: "codex-cli 0.155.1", reason: "" },
    ],
  });
  const command = {
    kind: "launch",
    repository: repo.path,
    worktree: tree.path,
    run: "codex",
  } as const;
  const confirm = vi.fn(() => Promise.resolve(false));
  await workspace.sidebarCommand(command, confirm);
  expect(confirm).not.toHaveBeenCalled();
  expect(agents.launch).toHaveBeenCalledWith(expect.objectContaining({ agent: "codex" }));
});

test("stop preserves a session and Close only removes exited sessions, never a worktree", async () => {
  const workspace = await launched();
  const confirm = vi.fn(() => Promise.resolve(true));
  await workspace.sidebarCommand({ kind: "stop", id: "t1" }, confirm);
  expect(vi.spyOn(deps.terminals, "stop")).toHaveBeenCalledWith("t1");
  expect(workspace.snapshot().terminals).toHaveLength(1);
  await expect(workspace.sidebarCommand({ kind: "close", id: "t1" }, confirm)).rejects.toThrow(
    "still running",
  );
  await workspace.exited("t1", 0);
  await expect(workspace.sidebarCommand({ kind: "restart", id: "t1" }, confirm)).rejects.toThrow(
    "Only shells",
  );
  await workspace.sidebarCommand({ kind: "close", id: "t1" }, confirm);
  expect(workspace.snapshot().terminals).toHaveLength(0);
  expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
  await expect(
    workspace.sidebarCommand({ kind: "restart", id: "foreign" }, confirm),
  ).rejects.toThrow("Unknown session");
});

test("an exited shell restarts in its original location and frees its old terminal", async () => {
  const workspace = new Workspace(deps);
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
    () => Promise.resolve(true),
  );
  await workspace.exited("t1", 0);
  vi.spyOn(deps.terminals, "create").mockResolvedValue("t2");
  await workspace.sidebarCommand({ kind: "restart", id: "t1" }, () => Promise.resolve(true));
  expect(workspace.snapshot().terminals.map((entry) => entry.id)).toEqual(["t2"]);
  expect(vi.spyOn(deps.terminals, "kill")).toHaveBeenCalledWith("t1");
});

test("repository and external worktree removal confirm and protect the main checkout", async () => {
  const workspace = new Workspace(deps);
  await workspace.sidebarCommand({ kind: "remove-repository", repository: repo.path }, () =>
    Promise.resolve(false),
  );
  expect(vi.mocked(deps.worktrees.removeRepository)).not.toHaveBeenCalled();
  await workspace.sidebarCommand({ kind: "remove-repository", repository: repo.path }, () =>
    Promise.resolve(true),
  );
  expect(vi.mocked(deps.worktrees.removeRepository)).toHaveBeenCalledWith(repo.path);
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, managed: false }]);
  for (const changes of ["", "?? private.txt\0"]) {
    vi.mocked(deps.worktrees.changes).mockResolvedValue(changes);
    const confirm = vi.fn(() => Promise.resolve(true));
    await workspace.sidebarCommand(
      { kind: "remove-worktree", repository: repo.path, worktree: tree.path },
      confirm,
    );
    expect(confirm).toHaveBeenCalledWith(
      changes
        ? { kind: "dirty-worktree", title: "Remove feature?", branch: "feature", changes }
        : { kind: "remove" },
    );
  }
  await expect(
    workspace.sidebarCommand(
      { kind: "remove-worktree", repository: repo.path, worktree: repo.path },
      () => Promise.resolve(true),
    ),
  ).rejects.toThrow("Worktree was removed");
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([tree]);
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
    () => Promise.resolve(true),
  );
  await expect(
    workspace.sidebarCommand({ kind: "remove-repository", repository: repo.path }, () =>
      Promise.resolve(true),
    ),
  ).rejects.toThrow("Close");
  await workspace.dispose();
  await expect(
    workspace.sidebarCommand({ kind: "stop", id: "t1" }, () => Promise.resolve(true)),
  ).rejects.toThrow("closed");
});

test("New worktree reuses an external checkout for shells", async () => {
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, managed: false }]);
  const workspace = new Workspace(deps);
  await workspace.startWorktree({ ...start, run: "shell" });
  expect(deps.worktrees.createWorktree).not.toHaveBeenCalled();
  expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: tree.path }),
  );
  await workspace.dispose();
});

test("New worktree refuses a checkout replaced during launch validation", async () => {
  vi.mocked(deps.worktrees.launchIdentity)
    .mockResolvedValueOnce("old")
    .mockResolvedValueOnce("new");
  const workspace = new Workspace(deps);
  await expect(workspace.startWorktree({ ...start, run: "shell" })).rejects.toThrow("changed");
  expect(vi.spyOn(deps.terminals, "create")).not.toHaveBeenCalled();
  await workspace.dispose();
});

test("home shells use only main-owned paths, persist and restart without a repository", async () => {
  const create = vi.spyOn(deps.terminals, "create");
  const { homeDirectory } = await import("../../../../src/main/workspace/home-shell");
  const workspace = new Workspace(deps);
  await workspace.sidebarCommand({ kind: "home-shell" }, () => Promise.resolve(false));
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: homeDirectory, shellIntegration: true }),
  );
  const entry = workspace.snapshot().terminals[0];
  expect(entry).toMatchObject({ home: true, kind: "shell", worktree: homeDirectory });
  if (!entry) throw new Error("Missing home shell");
  await workspace.exited(entry.id, 0);
  await workspace.sidebarCommand({ kind: "restart", id: entry.id }, () => Promise.resolve(false));
  expect(create).toHaveBeenCalledTimes(2);
});

test("panel facts require a registered repository", async () => {
  const workspace = new Workspace(deps);
  expect(() => workspace.panelFacts("/foreign", tree.path)).toThrow();
  await workspace.panelFacts(repo.path, tree.path);
  expect(deps.worktrees.panelFacts).toHaveBeenCalledWith(repo.path, tree.path);
});

test("restores home shells without repositories and rejects foreign home paths", async () => {
  const { homeDirectory } = await import("../../../../src/main/workspace/home-shell");
  const stored = {
    id: "home-1",
    kind: "shell" as const,
    agent: "shell" as const,
    home: true,
    repository: homeDirectory,
    worktree: homeDirectory,
    branch: null,
    attention: "evaluator" as const,
    state: null,
    dormant: true,
    exited: true,
  };
  deps.sessions = {
    load: () =>
      Promise.resolve([
        stored,
        { ...stored, id: "bad-home", worktree: "/other" },
        { ...stored, id: "bad-repo", repository: "/other" },
        { ...stored, id: "bad-agent", kind: "agent" },
      ]),
    save: () => Promise.resolve(),
    flush: () => Promise.resolve(),
  };
  const workspace = new Workspace(deps);
  await workspace.restore();
  expect(workspace.snapshot().terminals.map((entry) => entry.id)).toEqual(["home-1"]);
  expect(vi.mocked(deps.terminals, true).create.mock.calls).toHaveLength(0);
  await workspace.sidebarCommand({ kind: "close", id: "home-1" }, () => Promise.resolve(true));
  expect(workspace.snapshot().terminals).toEqual([]);
});

test("fact clipboard commands use main-owned values and reject unknown worktrees", async () => {
  const copy = vi.fn();
  deps.copyText = copy;
  const workspace = new Workspace(deps);
  await workspace.sidebarCommand({ kind: "copy-home-path" }, () => Promise.resolve(false));
  const { homeDirectory } = await import("../../../../src/main/workspace/home-shell");
  expect(copy).toHaveBeenLastCalledWith(homeDirectory);
  await workspace.sidebarCommand(
    { kind: "copy-worktree-path", repository: repo.path, worktree: tree.path },
    () => Promise.resolve(false),
  );
  expect(deps.worktrees.launchIdentity).toHaveBeenCalledWith(repo.path, tree.path);
  expect(copy).toHaveBeenLastCalledWith(tree.path);
  vi.mocked(deps.worktrees.launchIdentity).mockRejectedValueOnce(new Error("Unknown worktree"));
  await expect(
    workspace.sidebarCommand(
      { kind: "copy-worktree-path", repository: repo.path, worktree: "/foreign" },
      () => Promise.resolve(false),
    ),
  ).rejects.toThrow("Unknown worktree");
  expect(copy).toHaveBeenCalledTimes(2);
});

test("publishes transient MCP connection changes and removes them on revocation", async () => {
  const workspace = await launched();
  for (const state of ["connecting", "not-connected", "connected"] as const) {
    workspace.mcpConnectionChanged("t1", state);
    expect(workspace.snapshot().terminals[0]?.mcpConnection).toBe(state);
  }
  workspace.mcpConnectionChanged("t1", undefined);
  expect(workspace.snapshot().terminals[0]?.mcpConnection).toBeUndefined();
  await workspace.dispose();
});

test("prune uses the named repository and checkout, refuses sessions and releases its operation lock", async () => {
  const workspace = new Workspace(deps);
  const command = { kind: "prune-worktree", repository: repo.path, worktree: tree.path } as const;
  const confirm = vi.fn(() => Promise.resolve(true));
  await workspace.sidebarCommand(command, confirm);
  expect(deps.worktrees.pruneWorktree).toHaveBeenCalledWith(repo.path, tree.path);
  expect(confirm).not.toHaveBeenCalled();
  let finish: (() => void) | undefined;
  vi.mocked(deps.worktrees.pruneWorktree).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = workspace.sidebarCommand(command, confirm);
  await vi.waitFor(() => {
    expect(finish).toBeTypeOf("function");
  });
  await expect(workspace.sidebarCommand(command, confirm)).rejects.toThrow("busy");
  finish?.();
  await pending;
  vi.mocked(deps.worktrees.pruneWorktree).mockRejectedValueOnce(new Error("refused"));
  await expect(workspace.sidebarCommand(command, confirm)).rejects.toThrow("refused");
  await workspace.sidebarCommand(command, confirm);
  await workspace.startWorktree(start, confirm);
  await expect(workspace.sidebarCommand(command, confirm)).rejects.toThrow(
    "Close this worktree's sessions first",
  );
});

test("concurrent sidebar readers share pending inventory and reread after success or failure", async () => {
  const workspace = new Workspace(deps);
  const read = vi.mocked(deps.worktrees.listWorktrees);
  const gate = Promise.withResolvers<ReadonlyArray<typeof tree>>();
  read.mockReturnValueOnce(gate.promise);
  const first = workspace.sidebarInventory();
  const second = workspace.sidebarInventory();
  await vi.waitFor(() => {
    expect(read).toHaveBeenCalledTimes(1);
  });
  gate.resolve([tree]);
  expect(await first).toEqual(await second);
  await workspace.sidebarInventory();
  expect(read).toHaveBeenCalledTimes(2);
  const failure = Promise.withResolvers<ReadonlyArray<typeof tree>>();
  read.mockReturnValueOnce(failure.promise);
  const failed = workspace.sidebarInventory();
  const alsoFailed = workspace.sidebarInventory();
  const assertions = [
    expect(failed).rejects.toThrow("unavailable"),
    expect(alsoFailed).rejects.toThrow("unavailable"),
  ];
  failure.reject(new Error("unavailable"));
  await Promise.all(assertions);
  expect(read).toHaveBeenCalledTimes(3);
  await workspace.sidebarInventory();
  expect(read).toHaveBeenCalledTimes(4);
});

for (const change of ["refresh", "configure"] as const) {
  test(`sidebar ${change} invalidates pending inventory without letting its completion clear a newer read`, async () => {
    const workspace = new Workspace(deps);
    const read = vi.mocked(deps.worktrees.listWorktrees);
    const old = Promise.withResolvers<ReadonlyArray<typeof tree>>();
    const current = Promise.withResolvers<ReadonlyArray<typeof tree>>();
    read.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const previous = workspace.sidebarInventory();
    await vi.waitFor(() => {
      expect(read).toHaveBeenCalledTimes(1);
    });
    if (change === "refresh") workspace.refresh();
    else workspace.configure({ hooks: true, agents: { claude: true, codex: true, agy: true } });
    const latest = workspace.sidebarInventory();
    await vi.waitFor(() => {
      expect(read).toHaveBeenCalledTimes(2);
    });
    old.resolve([tree]);
    await previous;
    const joined = workspace.sidebarInventory();
    current.resolve([{ ...tree, branch: "changed" }]);
    expect((await latest).repositories[0]?.worktrees[0]?.branch).toBe("changed");
    expect(await joined).toEqual(await latest);
    expect(read).toHaveBeenCalledTimes(2);
  });
}
