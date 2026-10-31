import { expect, test, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import { agents, configDep, deps, launched, repo, scan, start, tree } from "./workspace-fixture";

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

test.each(["home", "config-shell", "config-agent"] as const)(
  "%s closes without querying Git review ownership",
  async (location) => {
    deps.config = configDep();
    const review = vi.mocked(deps.worktrees.reviewIdentity).mockImplementation(() => {
      throw new Error("Repository has not been added");
    });
    const workspace = new Workspace(deps);
    const confirm = vi.fn(() => Promise.resolve(true));
    await workspace.sidebarCommand(
      location === "home"
        ? { kind: "home-shell" }
        : { kind: "config-launch", run: location === "config-shell" ? "shell" : "claude" },
      confirm,
    );
    await workspace.exited("t1", 0);
    await workspace.sidebarCommand({ kind: "close", id: "t1" }, confirm);
    expect(workspace.snapshot().terminals).toEqual([]);
    expect(vi.spyOn(deps.terminals, "kill")).toHaveBeenCalledWith("t1");
    expect(review).not.toHaveBeenCalled();
    expect(deps.worktrees.removeWorktree).not.toHaveBeenCalled();
    await workspace.dispose();
  },
);

test("checkout close retains review ownership failures and the exited session", async () => {
  const workspace = await launched();
  await workspace.exited("t1", 0);
  vi.mocked(deps.worktrees.reviewIdentity).mockImplementation(() => {
    throw new Error("Review ownership unavailable");
  });
  await expect(
    workspace.sidebarCommand({ kind: "close", id: "t1" }, () => Promise.resolve(true)),
  ).rejects.toThrow("Review ownership unavailable");
  expect(deps.worktrees.reviewIdentity).toHaveBeenCalledWith(repo.path, tree.path);
  expect(workspace.snapshot().terminals.map((entry) => entry.id)).toEqual(["t1"]);
  expect(vi.spyOn(deps.terminals, "kill")).not.toHaveBeenCalled();
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
        ? {
            kind: "dirty-worktree",
            title: "Remove feature?",
            branch: "feature",
            path: tree.path,
            changes,
          }
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
  const result = await workspace.sidebarCommand({ kind: "home-shell" }, () =>
    Promise.resolve(false),
  );
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: homeDirectory, shellIntegration: true }),
  );
  const entry = workspace.snapshot().terminals[0];
  expect(entry).toMatchObject({ home: true, kind: "shell", worktree: homeDirectory });
  if (!entry) throw new Error("Missing home shell");
  expect(result).toEqual({ terminalId: entry.id });
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
    expect(failed).resolves.toMatchObject({ repositories: [{ unavailable: true }] }),
    expect(alsoFailed).resolves.toMatchObject({ repositories: [{ unavailable: true }] }),
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

test("broken-row cleanup uses its own safety capability rather than legacy prune", async () => {
  const workspace = new Workspace(deps);
  await workspace.sidebarCommand(
    { kind: "cleanup-worktree", repository: repo.path, worktree: tree.path },
    () => Promise.resolve(true),
  );
  expect(deps.worktrees.cleanupBrokenWorktree).toHaveBeenCalledWith(repo.path, tree.path);
  expect(deps.worktrees.pruneWorktree).not.toHaveBeenCalled();
  await workspace.dispose();
});

test("unavailable repository inventory is isolated and never becomes successful membership", async () => {
  const broken = { path: "/unavailable", name: "unavailable" };
  vi.mocked(deps.worktrees.listRepositories).mockReturnValue([broken, repo]);
  vi.mocked(deps.worktrees.listWorktrees).mockImplementation((path) => {
    if (path === broken.path) return Promise.reject(new Error("private Git diagnostic"));
    return Promise.resolve([tree]);
  });
  const workspace = new Workspace(deps);
  expect(await workspace.sidebarInventory()).toMatchObject({
    repositories: [
      { ...broken, unavailable: true, worktrees: [] },
      { ...repo, worktrees: [tree] },
    ],
  });
  await expect(workspace.worktrees(broken.path)).rejects.toThrow("private Git diagnostic");
  await expect(
    workspace.sidebarCommand(
      {
        kind: "launch",
        repository: broken.path,
        worktree: broken.path,
        run: "shell",
      },
      () => Promise.resolve(true),
    ),
  ).rejects.toThrow("private Git diagnostic");
  await workspace.sidebarCommand(
    {
      kind: "launch",
      repository: repo.path,
      worktree: tree.path,
      run: "shell",
    },
    () => Promise.resolve(true),
  );
  expect(workspace.snapshot().terminals).toHaveLength(1);
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([tree]);
  expect((await workspace.sidebarInventory()).repositories[0]).not.toHaveProperty("unavailable");
  await workspace.dispose();
});

test("checkout copy commands resolve main facts and refuse missing, redirected or credential-bearing targets", async () => {
  const { ForgeTracking } = await import("../../../../src/main/control/forge-tracking");
  const root = deps.agentPluginDirectory;
  if (!root) throw new Error("Missing fixture");
  const forge = new ForgeTracking(
    root,
    () => Promise.resolve("https://github.com/o/r"),
    () => {},
  );
  deps.forge = forge;
  const read = vi
    .spyOn(forge, "readBoard")
    .mockReturnValue({ number: 960, state: "OPEN", checks: null });
  const url = vi.spyOn(forge, "readUrl").mockReturnValue("https://github.com/o/r/pull/960");
  const copy = vi.fn();
  deps.copyText = copy;
  const workspace = new Workspace(deps);
  const command = (
    kind:
      | "copy-default-branch"
      | "copy-worktree-branch"
      | "copy-worktree-head"
      | "copy-remote-url"
      | "copy-pull-request-number"
      | "copy-pull-request-url",
  ) => ({ kind, repository: repo.path, worktree: tree.path });
  const facts = {
    changes: 0,
    upstream: null,
    commit: null,
    remote: "git@github.com:o/r.git",
    defaultBranch: "main",
    lastFetch: null,
    fetchFailed: false,
    merged: null,
  };
  vi.mocked(deps.worktrees.panelFacts).mockResolvedValue(facts);
  try {
    for (const [kind, value] of [
      ["copy-default-branch", "main"],
      ["copy-worktree-branch", tree.branch],
      ["copy-remote-url", facts.remote],
      ["copy-pull-request-number", "960"],
      ["copy-pull-request-url", "https://github.com/o/r/pull/960"],
    ] as const) {
      await workspace.sidebarCommand(command(kind), () => Promise.resolve(false));
      expect(copy).toHaveBeenLastCalledWith(value);
      copy.mockClear();
      vi.mocked(deps.worktrees.launchIdentity).mockRejectedValueOnce(new Error("unknown"));
      await expect(
        workspace.sidebarCommand(command(kind), () => Promise.resolve(false)),
      ).rejects.toThrow("unknown");
      expect(copy).not.toHaveBeenCalled();
    }
    await expect(
      workspace.sidebarCommand(command("copy-worktree-head"), () => Promise.resolve(false)),
    ).rejects.toThrow("unavailable");
    const head = "a".repeat(40);
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, branch: null, head }]);
    await workspace.sidebarCommand(command("copy-worktree-head"), () => Promise.resolve(false));
    expect(copy).toHaveBeenLastCalledWith(head);
    await expect(
      workspace.sidebarCommand(command("copy-worktree-branch"), () => Promise.resolve(false)),
    ).rejects.toThrow("unavailable");
    read.mockReturnValue(undefined);
    url.mockReturnValue(undefined);
    for (const kind of ["copy-pull-request-number", "copy-pull-request-url"] as const)
      await expect(
        workspace.sidebarCommand(command(kind), () => Promise.resolve(false)),
      ).rejects.toThrow("unavailable");
    for (const remote of [
      null,
      "https://token@github.com/o/r.git",
      "https://github.com/o/r?token=secret",
      "https://github.com/o/r#secret",
    ]) {
      vi.mocked(deps.worktrees.panelFacts).mockResolvedValue({ ...facts, remote });
      await expect(
        workspace.sidebarCommand(command("copy-remote-url"), () => Promise.resolve(false)),
      ).rejects.toThrow();
    }
    for (const remote of [
      "http://forge.test/o/r.git",
      "git://forge.test/o/r.git",
      "file:///checkout/repo.git",
      "/checkout/repo.git",
      "./repo.git",
      "../repo.git",
      "ssh://git@forge.test/project%20name.git",
    ]) {
      vi.mocked(deps.worktrees.panelFacts).mockResolvedValue({ ...facts, remote });
      await workspace.sidebarCommand(command("copy-remote-url"), () => Promise.resolve(false));
      expect(copy).toHaveBeenLastCalledWith(remote);
    }
    for (const remote of [
      "not a URL",
      "javascript:alert(1)",
      "ssh://git:secret@forge.test/repo",
      "https://forge.test/repo\nsecret",
    ]) {
      vi.mocked(deps.worktrees.panelFacts).mockResolvedValue({ ...facts, remote });
      await expect(
        workspace.sidebarCommand(command("copy-remote-url"), () => Promise.resolve(false)),
      ).rejects.toThrow("Unsafe");
    }
    url.mockReturnValue("https://forge.test/c/project/+/960");
    await workspace.sidebarCommand(command("copy-pull-request-url"), () => Promise.resolve(false));
    expect(copy).toHaveBeenLastCalledWith("https://forge.test/c/project/+/960");
    url.mockReturnValue("https://token@github.com/o/r/pull/960");
    await expect(
      workspace.sidebarCommand(command("copy-pull-request-url"), () => Promise.resolve(false)),
    ).rejects.toThrow("Unsafe");
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([]);
    await expect(
      workspace.sidebarCommand(command("copy-worktree-head"), () => Promise.resolve(false)),
    ).rejects.toThrow("Unknown checkout");
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([tree]);
    delete deps.copyText;
    await expect(
      workspace.sidebarCommand(command("copy-worktree-branch"), () => Promise.resolve(false)),
    ).rejects.toThrow("Copy unavailable");
  } finally {
    await workspace.dispose();
  }
});

test.each([
  "valid",
  "unknown-row",
  "unknown-path",
  "foreign-repository",
  "foreign-host",
  "removed-host",
  "changed-folder",
  "removed-repository",
  "missing-branch",
  "missing-hosts",
  "missing-clipboard",
] as const)("remote branch copy authorizes the registered placement: %s", async (mode) => {
  const { Hosts } = await import("../../../../src/main/setup/hosts");
  const { DEFAULT_SETTINGS } = await import("../../../../src/main/setup/settings");
  const { locationId } = await import("../../../../src/main/control/metadata");
  const { checkoutIdentity } = await import("../../../../src/main/workspace/worktree-identity");
  const { readSessions } = await import("../../../../src/main/workspace/session-store");
  let settings = {
    ...DEFAULT_SETTINGS,
    registeredHosts: [{ host: "worker", codeFolder: "/code" }],
  };
  const execute = vi.fn();
  const hosts = new Hosts(
    { get: () => settings, update: vi.fn(() => Promise.resolve(settings)) },
    () => deps.worktrees.listRepositories(),
    "0.1.0",
    execute,
  );
  deps.hosts = hosts;
  const remote = {
    repository: "/code/repository",
    path: "/code/.foom-worktree-topic",
    branch: "topic",
    identity: "a".repeat(64),
  };
  const path = `/foom-remote/${locationId(JSON.stringify(["worker", remote.path]))}`;
  const saved = readSessions([
    {
      id: "remote-child",
      agent: "claude",
      repository: repo.path,
      worktree: path,
      branch: "topic · worker",
      remote: true,
      placement: { kind: "remote", host: mode === "foreign-host" ? "other" : "worker" },
      remoteCheckout: remote,
      running: false,
    },
  ]);
  expect(saved).toHaveLength(1);
  deps.sessions = {
    load: () => Promise.resolve(mode === "unknown-row" ? [] : saved),
    save: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
  };
  // A synthetic remote row can never pass the real local membership check.
  vi.mocked(deps.worktrees.launchIdentity).mockImplementation((repository, worktree) =>
    checkoutIdentity(
      {
        listWorktrees: (repository) => deps.worktrees.listWorktrees(repository),
        validatePath: () => {},
        realpath: vi.fn(),
        git: vi.fn(),
      },
      repository,
      worktree,
      true,
    ),
  );
  const placement = vi.spyOn(hosts, "placement");
  const copy = vi.fn();
  if (mode === "missing-clipboard") delete deps.copyText;
  else deps.copyText = copy;
  const workspace = new Workspace(deps);
  try {
    await workspace.restore();
    hosts.rememberPlacement(repo.path, path, "worker", remote);
    if (mode === "foreign-repository") {
      const foreign = { path: "/repos/other", name: "other" };
      vi.mocked(deps.worktrees.listRepositories).mockReturnValue([repo, foreign]);
      hosts.rememberPlacement(foreign.path, path, "worker", remote);
    }
    if (mode === "removed-host") settings = { ...settings, registeredHosts: [] };
    if (mode === "changed-folder")
      settings = { ...settings, registeredHosts: [{ host: "worker", codeFolder: "/other" }] };
    if (mode === "removed-repository")
      vi.mocked(deps.worktrees.listRepositories).mockReturnValue([]);
    if (mode === "missing-branch")
      hosts.rememberPlacement(repo.path, path, "worker", { ...remote, branch: "" });
    if (mode === "missing-hosts") delete deps.hosts;
    const action = workspace.sidebarCommand(
      {
        kind: "copy-worktree-branch",
        repository: repo.path,
        worktree: mode === "unknown-path" ? "/foom-remote/unknown" : path,
      },
      () => Promise.resolve(false),
    );
    if (mode === "valid") {
      await action;
      expect(copy).toHaveBeenCalledExactlyOnceWith("topic");
    } else {
      await expect(action).rejects.toThrow();
      expect(copy).not.toHaveBeenCalled();
    }
    if (mode === "valid") expect(placement).toHaveBeenLastCalledWith(path, repo.path);
    expect(deps.worktrees.launchIdentity).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await workspace.dispose();
    hosts.dispose();
  }
});

test("session copies resolve the selected session, its relationships and the current handoff only", async () => {
  const copy = vi.fn();
  deps.copyText = copy;
  const workspace = await launched();
  agents.launch.mockResolvedValueOnce({ id: "child", attention: "hooks" });
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: tree.path, run: "claude" },
    () => Promise.resolve(true),
  );
  vi.spyOn(workspace.orchestration, "view").mockImplementation((id) =>
    id === "child"
      ? { role: "child", parentId: "t1", takenOver: false }
      : { role: "orchestrator", active: true, children: 1, history: [] },
  );
  const report = {
    seq: 2,
    status: "done" as const,
    summary: "Ready for review",
    links: [],
    timestamp: "2026-10-31T00:00:00.000Z",
  };
  const latest = vi.spyOn(workspace.orchestration.handoffs, "latest").mockReturnValue(report);
  try {
    const commands = [
      [{ kind: "copy-foom-session-id", id: "t1" }, "t1"],
      [{ kind: "copy-parent-id", id: "child" }, "t1"],
      [{ kind: "copy-child-id", id: "t1", child: "child" }, "child"],
      [{ kind: "copy-handoff-summary", id: "child", seq: 2 }, report.summary],
    ] as const;
    for (const [command, value] of commands) {
      await workspace.sidebarCommand(command, () => Promise.resolve(false));
      expect(copy).toHaveBeenLastCalledWith(value);
      copy.mockClear();
      await expect(
        workspace.sidebarCommand({ ...command, id: "unknown" }, () => Promise.resolve(false)),
      ).rejects.toThrow("Unknown session");
      expect(copy).not.toHaveBeenCalled();
    }
    for (const command of [
      { kind: "copy-parent-id", id: "t1" },
      { kind: "copy-child-id", id: "child", child: "t1" },
      { kind: "copy-handoff-summary", id: "child", seq: 1 },
    ] as const)
      await expect(workspace.sidebarCommand(command, () => Promise.resolve(false))).rejects.toThrow(
        "unavailable",
      );
    latest.mockReturnValue(undefined);
    await expect(
      workspace.sidebarCommand({ kind: "copy-handoff-summary", id: "child", seq: 2 }, () =>
        Promise.resolve(false),
      ),
    ).rejects.toThrow("unavailable");
  } finally {
    await workspace.dispose();
  }
});

test("error text copies use only closed sentence IDs", async () => {
  const copy = vi.fn();
  deps.copyText = copy;
  const workspace = new Workspace(deps);
  await workspace.sidebarCommand({ kind: "copy-error-text", error: "worktree-locked" }, () =>
    Promise.resolve(false),
  );
  expect(copy).toHaveBeenCalledExactlyOnceWith("This worktree is locked.");
  copy.mockRejectedValueOnce(new Error("clipboard"));
  await expect(
    workspace.sidebarCommand({ kind: "copy-error-text", error: "operation-failed" }, () =>
      Promise.resolve(false),
    ),
  ).rejects.toThrow("clipboard");
  await workspace.dispose();
});
