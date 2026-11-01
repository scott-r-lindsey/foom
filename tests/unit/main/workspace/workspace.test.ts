import { expect, test, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import type { WorkspaceDependencies } from "../../../../src/main/workspace/workspace-types";
import {
  agents,
  bound,
  commit,
  deps,
  evaluated,
  launched,
  prepare,
  receiver,
  repo,
  start,
  startReceiver,
  states,
  tails,
  terminalTail,
  tree,
} from "./workspace-fixture";

test("launches into a known repository and lists the terminal with its branch", async () => {
  const workspace = await launched();
  expect(agents.scan).toHaveBeenCalledOnce();
  expect(workspace.snapshot()).toMatchObject({
    repositories: [repo],
    terminals: [
      {
        id: "t1",
        kind: "agent",
        agent: "claude",
        repository: repo.path,
        worktree: tree.path,
        branch: "feature",
        attention: "hooks",
        bypass: false,
        state: null,
        exited: false,
        execution: { terminalId: "t1", launch: 1, revision: 0, turn: 0, phase: "starting" },
      },
    ],
  });
  await workspace.quiet("t1");
  expect(workspace.snapshot().terminals[0]?.state?.state).toBe("needs_input");
});

test("records an unknown branch as null and rejects unknown repositories", async () => {
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([]);
  const workspace = await launched();
  expect(workspace.snapshot().terminals[0]?.branch).toBeNull();
  await expect(
    workspace.launch({ agent: "claude", repository: "/other", worktree: "/x", cols: 80, rows: 24 }),
  ).rejects.toThrow("Repository has not been added");
  await expect(workspace.worktrees("/other")).rejects.toThrow("Repository has not been added");
  await expect(workspace.createWorktree("/other", "b", "root")).rejects.toThrow(
    "Repository has not been added",
  );
});

test("adds repositories, lists and creates worktrees through the service", async () => {
  const changed = vi.fn();
  const workspace = new Workspace({ ...deps, onChange: changed });
  await expect(workspace.addRepository("/repos/app")).resolves.toBe(repo);
  expect(changed).toHaveBeenCalledOnce();
  await expect(workspace.worktrees(repo.path)).resolves.toEqual([tree]);
  const launch = vi.spyOn(deps.terminals, "create");
  await expect(workspace.createWorktree(repo.path, "feature", "adjacent")).resolves.toEqual({
    ...tree,
    outcome: "new",
  });
  expect(vi.mocked(deps.worktrees.createWorktree)).toHaveBeenCalledWith(repo.path, "feature", {
    location: "adjacent",
  });
  // Creating refreshes the sidebar and never launches anything.
  expect(changed).toHaveBeenCalledTimes(2);
  expect(launch).not.toHaveBeenCalled();
  vi.mocked(deps.worktrees.createWorktree).mockResolvedValueOnce({
    path: tree.path,
    outcome: "open",
  });
  await expect(workspace.createWorktree(repo.path, "feature")).resolves.toMatchObject({
    outcome: "open",
  });
  expect(vi.mocked(deps.worktrees.createWorktree)).toHaveBeenLastCalledWith(repo.path, "feature", {
    location: "root",
  });
  await expect(workspace.branches(repo.path)).resolves.toMatchObject({ head: "main" });
  await expect(workspace.branches("/elsewhere")).rejects.toThrow("not been added");
  let finish = () => {};
  vi.mocked(deps.worktrees.createWorktree).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => {
          resolve({ path: tree.path, outcome: "new" });
        };
      }),
  );
  const first = workspace.createWorktree(repo.path, "same");
  await expect(workspace.createWorktree(repo.path, "same")).rejects.toThrow("busy");
  await vi.waitFor(() => {
    expect(vi.mocked(deps.worktrees.createWorktree)).toHaveBeenCalledTimes(3);
  });
  finish();
  await first;
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([]);
  await expect(workspace.createWorktree(repo.path, "feature", "root")).rejects.toThrow(
    "Created worktree is missing",
  );
});

test("uses the real agent service by default", async () => {
  const defaults: WorkspaceDependencies = { ...deps };
  delete defaults.agents;
  const workspace = new Workspace(defaults);
  await expect(
    workspace.launch({
      agent: "claude",
      repository: repo.path,
      worktree: "relative",
      cols: 80,
      rows: 24,
    }),
  ).rejects.toThrow("Invalid worktree path");
});

test("hook preparation starts the receiver once, retries a failed start, and gives agy per-launch credentials", async () => {
  const workspace = new Workspace(deps);
  startReceiver.mockRejectedValueOnce(new Error("port"));
  await expect(prepare?.("claude")).rejects.toThrow("port");
  const first = await prepare?.("claude");
  const second = await prepare?.("codex");
  expect(startReceiver).toHaveBeenCalledTimes(2);
  expect(first?.v2?.values["observerCommand:lifecycle"]).toMatch(/^sh '.*observer\.sh'$/u);
  expect(String(second?.v2?.values["observerArgv:notify"])).toMatch(/observer\.sh$/u);
  const agy = await prepare?.("agy");
  expect(agy?.env["FOOM_TOKEN"]).toBeDefined();
  agy?.dispose();
  first?.dispose();
  second?.dispose();
  await workspace.dispose();
  expect(receiver.close).toHaveBeenCalledOnce();
});

test("dispose releases agents, closes the receiver once, and refuses new work", async () => {
  const workspace = await launched();
  await workspace.dispose();
  await workspace.dispose();
  expect(agents.dispose).toHaveBeenCalledOnce();
  expect(receiver.close).not.toHaveBeenCalled();
  await expect(
    workspace.launch({
      agent: "claude",
      repository: repo.path,
      worktree: tree.path,
      cols: 80,
      rows: 24,
    }),
  ).rejects.toThrow("Workspace is closed");
  await workspace.quiet("t1");
  expect(evaluated).toHaveLength(0);
});

test("dispose tolerates a receiver that fails while starting", async () => {
  const workspace = new Workspace(deps);
  let fail: (error: Error) => void = () => {};
  startReceiver.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      fail = reject;
    }),
  );
  const attempt = prepare?.("claude");
  const disposing = workspace.dispose();
  fail(new Error("port"));
  await expect(attempt).rejects.toThrow("port");
  await expect(disposing).resolves.toBeUndefined();
});

test("the branch is looked up before spawning, so a failed lookup launches nothing", async () => {
  vi.mocked(deps.worktrees.listWorktrees).mockRejectedValueOnce(new Error("git"));
  const workspace = new Workspace(deps);
  await expect(
    workspace.launch({
      agent: "claude",
      repository: repo.path,
      worktree: tree.path,
      cols: 80,
      rows: 24,
    }),
  ).rejects.toThrow("git");
  expect(agents.launch).not.toHaveBeenCalled();
  expect(workspace.snapshot().terminals).toEqual([]);
});

test("a hook that arrives before launch returns is kept", async () => {
  const workspace = new Workspace(deps);
  tails.set("t1", ["╭ Allow Bash(npm test)? ╮"]);
  let early: Promise<void> = Promise.resolve();
  agents.launch.mockImplementationOnce(async () => {
    const key = await bound();
    early = workspace.hook({
      terminalId: key,
      action: "needs_input",
      signal: "plugin:claude:PermissionRequest",
    });
    await early;
    return { id: "t1", attention: "hooks" };
  });
  await workspace.launch({
    agent: "claude",
    repository: repo.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
  });
  expect(states.at(-1)).toMatchObject({
    state: "needs_input",
    signal: "plugin:claude:PermissionRequest",
  });
  await workspace.quiet("t1");
  expect(workspace.snapshot().terminals[0]?.state).toMatchObject({ state: "needs_input" });
});

test("shells get only the All sessions layer; agents get their layers and record names", async () => {
  const layers = {
    shell: [[{ name: "HTTPS_PROXY", value: "http://proxy:1" }]],
    claude: [[{ name: "HTTPS_PROXY", value: "http://proxy:1" }], [{ name: "ONLY", value: "1" }]],
  };
  const environment = vi.fn((target: string) =>
    target === "shell" ? layers.shell : target === "claude" ? layers.claude : [[]],
  );
  agents.launch.mockResolvedValue({ id: "t9", attention: "hooks", environment: ["ONLY"] });
  const create = vi.spyOn(deps.terminals, "create");
  const workspace = new Workspace({ ...deps, environment });
  expect(await workspace.startWorktree(start)).toBe("t1");
  const spec = create.mock.calls.at(-1)?.[0];
  expect(spec?.env).toMatchObject({ HTTPS_PROXY: "http://proxy:1" });
  expect(spec?.env?.["NO_PROXY"]).toContain("127.0.0.1");
  expect(spec?.env).not.toHaveProperty("ONLY");
  await workspace.sidebarCommand({ kind: "home-shell" }, () => Promise.resolve(false));
  expect(create.mock.calls.at(-1)?.[0].env).toMatchObject({ HTTPS_PROXY: "http://proxy:1" });
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree: tree.path, run: "claude" },
    () => Promise.resolve(true),
  );
  expect(agents.launch.mock.calls.at(-1)?.[0].environment).toBe(layers.claude);
  expect(environment).toHaveBeenCalledWith("claude");
  const terminals = workspace.snapshot().terminals;
  expect(terminals.find((entry) => entry.id === "t9")?.environment).toEqual(["ONLY"]);
  expect(terminals.find((entry) => entry.kind === "shell")?.environment).toEqual(
    expect.arrayContaining(["HTTPS_PROXY", "NO_PROXY"]),
  );
});

test("launches multiple shells in a managed worktree", async () => {
  const workspace = new Workspace(deps);
  expect(await workspace.startWorktree(start)).toBe("t1");
  expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: tree.path, cols: 80, rows: 24 }),
  );
  expect(workspace.snapshot().terminals[0]).toMatchObject({ kind: "shell", branch: "feature" });
  workspace.foreground("t1", "vim");
  workspace.foreground("t1", "vim");
  expect(workspace.snapshot().terminals[0]?.foregroundProgram).toBe("vim");
  workspace.foreground("t1", "");
  expect(workspace.snapshot().terminals[0]?.foregroundProgram).toBe("");
  vi.spyOn(deps.terminals, "create").mockResolvedValueOnce("t2");
  expect(await workspace.startWorktree(start)).toBe("t2");
  expect(workspace.snapshot().terminals).toHaveLength(2);
  await workspace.exited("t1", 0);
  await workspace.startWorktree(start);
  await workspace.dispose();
});

test("creates missing worktrees at the configured location and launches Codex without consent", async () => {
  const listing = vi
    .spyOn(deps.worktrees, "listWorktrees")
    .mockResolvedValueOnce([])
    .mockResolvedValue([tree]);
  const workspace = new Workspace(deps);
  workspace.configure({
    hooks: true,
    agents: { claude: true, codex: true, agy: true },
    worktreeLocation: "adjacent",
  });
  await workspace.startWorktree({
    ...start,
    run: "codex",
  });
  expect(vi.mocked(deps.worktrees.createWorktree)).toHaveBeenCalledWith(repo.path, "feature", {
    location: "adjacent",
  });
  expect(agents.launch).toHaveBeenCalledWith(expect.objectContaining({ agent: "codex" }));
  await workspace.exited("t1", 0);
  await workspace.startWorktree({
    ...start,
    run: "codex",
  });
  expect(listing).toHaveBeenCalled();
  await workspace.dispose();
});

test("refuses unknown, bare, locked, prunable and invalid branches without spawning", async () => {
  const workspace = new Workspace(deps);
  await expect(workspace.startWorktree({ ...start, repository: "/unknown" })).rejects.toThrow(
    "not been added",
  );
  for (const change of [{ bare: true }, { locked: true }, { prunable: true }]) {
    vi.spyOn(deps.worktrees, "listWorktrees").mockResolvedValueOnce([{ ...tree, ...change }]);
    await expect(workspace.startWorktree(start)).rejects.toThrow();
  }
  vi.spyOn(deps.worktrees, "validateBranch").mockRejectedValueOnce(new Error("Invalid branch"));
  await expect(workspace.startWorktree(start)).rejects.toThrow("Invalid branch");
  expect(vi.spyOn(deps.terminals, "create")).not.toHaveBeenCalled();
  await workspace.dispose();
  await expect(workspace.startWorktree(start)).rejects.toThrow("closed");
});

test("serializes branch launches and unlocks after failure", async () => {
  const deferred = Promise.withResolvers<undefined>();
  vi.spyOn(deps.worktrees, "validateBranch").mockReturnValueOnce(deferred.promise);
  const workspace = new Workspace(deps);
  const first = workspace.startWorktree(start);
  await expect(workspace.startWorktree(start)).rejects.toThrow("busy");
  deferred.reject(new Error("invalid"));
  await expect(first).rejects.toThrow("invalid");
  await workspace.startWorktree(start);
  await workspace.dispose();
});

test.each([
  ["id", "claude"],
  ["id", "shell"],
  ["sidebar", "claude"],
  ["sidebar", "shell"],
] as const)("%s removal refuses running %s sessions before confirmation", async (path, run) => {
  const workspace = new Workspace(deps);
  await workspace.startWorktree({ ...start, run });
  const confirm = vi.fn(() => Promise.resolve(true));
  const remove = () =>
    path === "id"
      ? workspace.removeWorktree("t1", confirm)
      : workspace.sidebarCommand(
          { kind: "remove-worktree", repository: repo.path, worktree: tree.path },
          confirm,
        );
  await expect(remove()).rejects.toThrow("A session is running in this worktree");
  expect(confirm).not.toHaveBeenCalled();
  expect(vi.spyOn(deps.terminals, "stop")).not.toHaveBeenCalled();
  expect(vi.spyOn(deps.terminals, "kill")).not.toHaveBeenCalled();
  expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
  await workspace.exited("t1", 0);
  await remove();
  expect(workspace.snapshot().terminals).toEqual([]);
  await workspace.dispose();
});

test.each(["id", "sidebar"] as const)(
  "%s removal revalidates a session launched during confirmation before stopping anything",
  async (path) => {
    const workspace = new Workspace(deps);
    await workspace.startWorktree(start);
    await workspace.exited("t1", 0);
    const confirm = vi.fn(async () => {
      // A changed branch name gives the concurrent launch a different branch lock.
      vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([{ ...tree, branch: "renamed" }]);
      vi.spyOn(deps.terminals, "create").mockResolvedValue("t2");
      await workspace.sidebarCommand(
        { kind: "launch", repository: repo.path, worktree: tree.path, run: "shell" },
        () => Promise.resolve(true),
      );
      return true;
    });
    const removal =
      path === "id"
        ? workspace.removeWorktree("t1", confirm)
        : workspace.sidebarCommand(
            { kind: "remove-worktree", repository: repo.path, worktree: tree.path },
            confirm,
          );
    await expect(removal).rejects.toThrow("A session is running in this worktree");
    expect(confirm).toHaveBeenCalledOnce();
    expect(vi.spyOn(deps.terminals, "stop")).not.toHaveBeenCalled();
    expect(vi.spyOn(deps.terminals, "kill")).not.toHaveBeenCalled();
    expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
    expect(workspace.snapshot().terminals.find((entry) => entry.id === "t2")?.exited).toBe(false);
    expect(workspace.snapshot().terminals).toHaveLength(2);
    await workspace.exited("t2", 0);
    await workspace.removeWorktree("t1", () => Promise.resolve(true));
    expect(workspace.snapshot().terminals).toEqual([]);
    await workspace.dispose();
  },
);

test("snapshots bypass policy per launch and never accepts defaults from a renderer request", async () => {
  const workspace = new Workspace(deps);
  const config = { hooks: true, agents: { claude: true, codex: true, agy: true } };
  workspace.configure({
    ...config,
    agentArguments: { claude: ["--dangerously-skip-permissions"], codex: [], agy: [] },
  });
  const request = {
    agent: "claude" as const,
    repository: repo.path,
    worktree: tree.path,
    cols: 80,
    rows: 24,
    defaultArguments: ["--settings", "hostile"],
  };
  await workspace.launch(request);
  expect(agents.launch).toHaveBeenLastCalledWith(
    expect.objectContaining({ defaultArguments: ["--dangerously-skip-permissions"] }),
  );
  workspace.configure(config);
  expect(workspace.snapshot().terminals[0]?.bypass).toBe(true);
  await workspace.exited("t1", 0);
  agents.launch.mockResolvedValueOnce({ id: "t2", attention: "hooks" });
  await workspace.launch(request);
  expect(agents.launch).toHaveBeenLastCalledWith(expect.objectContaining({ defaultArguments: [] }));
  expect(workspace.snapshot().terminals.find(({ id }) => id === "t2")?.bypass).toBe(false);
  await workspace.dispose();
});

test("refresh synchronizes registered watches without affecting terminals, and disposal stops notifications", async () => {
  const watcher = { sync: vi.fn(), dispose: vi.fn() };
  const onChange = vi.fn();
  const kill = vi.fn<WorkspaceDependencies["terminals"]["kill"]>();
  deps.terminals.kill = kill;
  const workspace = new Workspace({ ...deps, watcher, onChange });
  expect(watcher.sync).toHaveBeenCalledWith([repo]);
  workspace.refresh();
  expect(onChange).toHaveBeenCalledOnce();
  expect(kill).not.toHaveBeenCalled();
  await workspace.dispose();
  workspace.refresh();
  expect(watcher.dispose).toHaveBeenCalledOnce();
  expect(onChange).toHaveBeenCalledOnce();
});

test.each(["shell", "claude", "remove"] as const)(
  "rejects stale sidebar %s targets before confirmation or process operations",
  async (run) => {
    const kill = vi.fn<WorkspaceDependencies["terminals"]["kill"]>();
    const create = vi.fn<WorkspaceDependencies["terminals"]["create"]>();
    deps.terminals.kill = kill;
    deps.terminals.create = create;
    const workspace = new Workspace(deps);
    vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([]);
    const confirm = vi.fn(() => Promise.resolve(true));
    await expect(
      workspace.sidebarCommand(
        run === "remove"
          ? { kind: "remove-worktree", repository: repo.path, worktree: tree.path }
          : { kind: "launch", repository: repo.path, worktree: tree.path, run },
        confirm,
      ),
    ).rejects.toThrow("Worktree was removed");
    expect(confirm).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(vi.mocked(deps.worktrees.removeWorktree)).not.toHaveBeenCalled();
    await workspace.dispose();
  },
);

test("starts control lazily once, retries failed initialization and closes independently of hooks", async () => {
  const binding = { env: {}, bind: vi.fn(), dispose: vi.fn() };
  const runtime = {
    prepare: vi.fn(() => binding),
    close: vi.fn(() => Promise.resolve()),
    setRole: vi.fn(),
  };
  const start = vi.fn(() => Promise.resolve(runtime));
  start.mockRejectedValueOnce(new Error("private directory unavailable"));
  let control: Parameters<NonNullable<WorkspaceDependencies["agents"]>>[1];
  deps.agents = (_hooks, next) => {
    control = next;
    return agents;
  };
  deps.control = start;
  const workspace = new Workspace(deps);
  expect(start).not.toHaveBeenCalled();
  if (!control) throw new Error("Expected launch registrar");
  await expect(control(repo.path, tree.path)).rejects.toThrow("private directory unavailable");
  await Promise.all([control(repo.path, tree.path, "hook-session"), control(repo.path, tree.path)]);
  expect(start).toHaveBeenCalledTimes(2);
  expect(runtime.prepare).toHaveBeenCalledWith(repo.path, tree.path, "hook-session");
  await workspace.dispose();
  expect(runtime.close).toHaveBeenCalledOnce();
});

test.each([
  { agent: "claude", titles: ["◐ Claude", "◓ Claude", "◑ Claude", "◒ Claude"] },
  { agent: "codex", titles: ["⠋ codex", "⠙ codex", "⠹ codex", "⠸ codex"] },
  { agent: "codex", titles: ["[ . ] Action Required", "[ ! ] Action Required"] },
] as const)("$agent animated titles commit once: $titles", async ({ agent, titles }) => {
  tails.set("t1", ["Agent output"]);
  const workspace = new Workspace(deps);
  await workspace.launch({ agent, repository: repo.path, worktree: tree.path, cols: 80, rows: 24 });
  for (const title of [...titles, ...titles])
    await workspace.evidence("t1", { title, progress: null });
  expect(terminalTail).toHaveBeenCalledTimes(1);
  expect(commit).toHaveBeenCalledTimes(1);
  const state = states.at(-1);
  await workspace.quiet("t1");
  expect(evaluated.at(-1)?.evidence?.title).toBe(titles.at(-1));
  expect(commit).toHaveBeenCalledTimes(1);
  expect(states).toHaveLength(1);
  expect(states.at(-1)).toBe(state);
  await workspace.dispose();
});

test("host recipes are human-owned remote shells without hub environment or orchestration grants", async () => {
  const create = vi.spyOn(deps.terminals, "create");
  const workspace = new Workspace(deps);
  const target = {
    host: "worker",
    profile: "f".repeat(32),
    human: true as const,
    recipe: {
      tool: "git",
      action: "install" as const,
      distro: "debian" as const,
      digest: "a".repeat(64),
    },
  };
  await workspace.startHostRecipe(target);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ remote: target, env: {} }));
  expect(workspace.snapshot().terminals[0]).toMatchObject({
    kind: "shell",
    home: true,
    remote: true,
    placement: { kind: "remote", host: "worker" },
  });
});

test.each([true, false])(
  "remote recipe restart preserves its host and never replays installation (registered: %s)",
  async (registered) => {
    const create = vi.spyOn(deps.terminals, "create");
    const target = { host: "worker", profile: "f".repeat(32), human: true as const };
    const shellTarget = vi.fn(() => target);
    const workspace = new Workspace({
      ...deps,
      ...(registered
        ? {
            hosts: {
              fleet: () => Promise.resolve([]),
              worktree: vi.fn(),
              registered: () => ({ host: "worker", codeFolder: "/remote/code" }),
              requireAgent: () => Promise.resolve(),
              shellTarget,
            },
          }
        : {}),
    });
    await workspace.startHostRecipe({
      ...target,
      recipe: { tool: "git", action: "install", distro: "debian", digest: "a".repeat(64) },
    });
    await workspace.exited("t1", 0);
    create.mockResolvedValue("t2");
    const restart = workspace.sidebarCommand({ kind: "restart", id: "t1" }, () =>
      Promise.resolve(true),
    );
    if (registered) {
      await restart;
      expect(shellTarget).toHaveBeenCalledWith("worker");
      expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ remote: target, env: {} }));
      expect(workspace.snapshot().terminals.map((row) => row.id)).toEqual(["t2"]);
    } else {
      await expect(restart).rejects.toMatchObject({ reason: "remote_host_unreachable" });
      expect(create).toHaveBeenCalledTimes(1);
    }
  },
);
