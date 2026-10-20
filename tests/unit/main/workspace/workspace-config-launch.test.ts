import { expect, test, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import { agents, configDep, deps, prepare, receiver, scan } from "./workspace-fixture";

test("config sessions run in the config folder with the bundled CLI", async () => {
  const create = vi.spyOn(deps.terminals, "create");
  deps.config = configDep();
  const workspace = new Workspace(deps);
  const no = () => Promise.resolve(false);
  await workspace.sidebarCommand({ kind: "config-launch", run: "shell" }, no);
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: "/home/.foom/config",
      shellIntegration: true,
      env: expect.objectContaining({
        PATH: expect.stringMatching(/^\/app\/console[:;]\/login\/bin$/) as unknown,
        FOOM_CONFIG_TOKEN: expect.stringMatching(/^[a-f0-9]{64}$/u) as unknown,
        FOOM_CONFIG_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/u) as unknown,
      }) as unknown,
    }),
  );
  expect(workspace.snapshot().terminals[0]).toMatchObject({
    config: true,
    kind: "shell",
    repository: "/home/.foom/config",
    worktree: "/home/.foom/config",
  });
  await workspace.exited("t1", 0);
  await workspace.sidebarCommand({ kind: "restart", id: "t1" }, no);
  expect(create).toHaveBeenCalledTimes(2);
  await workspace.dispose();
});

test.each(["shell", "claude"] as const)(
  "concurrent config launches start %s and shell independently",
  async (first) => {
    const checked = Promise.withResolvers<undefined>();
    const check = vi.fn(async () => {
      await checked.promise;
    });
    deps.config = configDep(check);
    const create = vi
      .spyOn(deps.terminals, "create")
      .mockResolvedValueOnce("shell-1")
      .mockResolvedValueOnce("shell-2");
    agents.launch.mockResolvedValue({ id: "agent-1", attention: "hooks" });
    const workspace = new Workspace(deps);
    const no = () => Promise.resolve(false);
    const launches = [
      workspace.sidebarCommand({ kind: "config-launch", run: first }, no),
      workspace.sidebarCommand({ kind: "config-launch", run: "shell" }, no),
    ];
    expect(check).toHaveBeenCalledTimes(2);
    checked.resolve(undefined);
    await Promise.all(launches);
    const rows = workspace.snapshot().terminals;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows.every((row) => row.config && !row.exited)).toBe(true);
    expect(create).toHaveBeenCalledTimes(first === "shell" ? 2 : 1);
    if (first === "claude") {
      const request = agents.launch.mock.calls[0]?.[0];
      expect(request).toMatchObject({
        configCli: "/app/console",
        worktree: deps.config.root,
        sharedCheckout: true,
      });
      expect(request?.control).toBeUndefined();
      expect(request?.checkoutIdentity).toBeUndefined();
    }
    // Another launch after both have started also creates its own session.
    create.mockResolvedValueOnce("shell-3");
    await workspace.sidebarCommand({ kind: "config-launch", run: "shell" }, no);
    expect(workspace.snapshot().terminals).toHaveLength(3);
    expect(deps.worktrees.createWorktree).not.toHaveBeenCalled();
    await workspace.dispose();
  },
);

test.each(["claude", "codex", "agy"] as const)(
  "config %s agents preserve defaults and resume in the same row",
  async (agent) => {
    deps.config = configDep();
    agents.launch.mockResolvedValue({ id: "c1", attention: "hooks" });
    const workspace = new Workspace(deps);
    workspace.configure({
      hooks: true,
      agents: { claude: true, codex: true, agy: true },
      agentArguments: {
        claude: ["--model", "test"],
        codex: ["--model", "test"],
        agy: ["-i", "user greeting"],
      },
    });
    const defaults = agent === "agy" ? ["-i", "user greeting"] : ["--model", "test"];
    const no = () => Promise.resolve(false);
    await workspace.sidebarCommand({ kind: "config-launch", run: agent }, no);
    expect(agents.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        agent,
        repository: "/home/.foom/config",
        worktree: "/home/.foom/config",
        configCli: "/app/console",
        defaultArguments: defaults,
      }),
    );
    expect(deps.worktrees.createWorktree).not.toHaveBeenCalled();
    expect(workspace.snapshot().terminals[0]).toMatchObject({
      id: "c1",
      config: true,
      agent,
      attention: "hooks",
    });
    // Replacing or resuming this conversation must work while another config session runs.
    vi.spyOn(deps.terminals, "create").mockResolvedValue("config-shell");
    await workspace.sidebarCommand({ kind: "config-launch", run: "shell" }, no);
    await workspace.exited("c1", 0);
    await workspace.sidebarCommand({ kind: "new-conversation", id: "c1" }, no);
    expect(agents.launch.mock.calls.at(-1)?.[0].conversationId).toBeUndefined();
    const hooks = await prepare?.(agent);
    hooks?.bind?.("c1");
    const key = receiver.register.mock.calls.at(-1)?.[0] ?? "";
    await workspace.hook({
      terminalId: key,
      action: "classify",
      signal:
        agent === "agy"
          ? "agy:Stop"
          : agent === "codex"
            ? "codex:agent-turn-complete"
            : "claude:Stop",
      conversationId: "saved-id",
    });
    await workspace.exited("c1", 0);
    await workspace.sidebarCommand({ kind: "resume", id: "c1" }, no);
    expect(agents.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        terminalId: "c1",
        configCli: "/app/console",
        conversationId: "saved-id",
        defaultArguments: defaults,
      }),
    );
    await workspace.exited("c1", 0);
    await workspace.sidebarCommand({ kind: "new-conversation", id: "c1" }, no);
    expect(agents.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ terminalId: "c1", configCli: "/app/console" }),
    );
    expect(agents.launch.mock.calls.at(-1)?.[0].conversationId).toBeUndefined();
    await workspace.dispose();
  },
);

test("config sessions get Environment layers with the bundled CLI first on PATH", async () => {
  deps.config = configDep();
  const environment = vi.fn((target: string) =>
    target === "shell"
      ? [[{ name: "PATH", value: "/opt/bin" }]]
      : [[], [{ name: "HTTPS_PROXY", value: "http://proxy:1" }]],
  );
  agents.launch.mockResolvedValue({ id: "c1", attention: "hooks", environment: ["HTTPS_PROXY"] });
  const create = vi.spyOn(deps.terminals, "create");
  const workspace = new Workspace({ ...deps, environment });
  const no = () => Promise.resolve(false);
  await workspace.sidebarCommand({ kind: "config-launch", run: "shell" }, no);
  const env = create.mock.calls.at(-1)?.[0].env ?? {};
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  expect(env[pathKey]).toMatch(/^\/app\/console[:;]\/opt\/bin[:;]\/login\/bin$/);
  expect(workspace.snapshot().terminals[0]).toMatchObject({ config: true, environment: ["PATH"] });
  await workspace.exited("t1", 0);
  await workspace.sidebarCommand({ kind: "config-launch", run: "codex" }, no);
  expect(environment).toHaveBeenCalledWith("codex");
  expect(agents.launch).toHaveBeenLastCalledWith(
    expect.objectContaining({ configCli: "/app/console", environment: environment("codex") }),
  );
  expect(workspace.snapshot().terminals.find((entry) => entry.id === "c1")).toMatchObject({
    config: true,
    environment: ["HTTPS_PROXY"],
  });
  await workspace.dispose();
});

test("config launches refuse when the folder is unavailable or turned-off agents are asked", async () => {
  const no = () => Promise.resolve(false);
  await expect(
    new Workspace(deps).sidebarCommand({ kind: "config-launch", run: "shell" }, no),
  ).rejects.toThrow("Foom config is unavailable");
  await expect(
    new Workspace(deps).sidebarCommand({ kind: "copy-config-path" }, no),
  ).rejects.toThrow("Foom config is unavailable");
  deps.config = configDep(
    vi.fn(() => Promise.reject(new Error("Foom config cannot be inside a repository"))),
  );
  const workspace = new Workspace(deps);
  await expect(
    workspace.sidebarCommand({ kind: "config-launch", run: "shell" }, no),
  ).rejects.toThrow("inside a repository");
  deps.config = configDep();
  const disabled = new Workspace(deps);
  disabled.configure({ hooks: true, agents: { claude: false, codex: true, agy: true } });
  await expect(
    disabled.sidebarCommand({ kind: "config-launch", run: "claude" }, no),
  ).rejects.toThrow("turned off");
  agents.launch.mockRejectedValueOnce(new Error("not installed"));
  const failing = new Workspace(deps);
  await expect(
    failing.sidebarCommand({ kind: "config-launch", run: "claude" }, no),
  ).rejects.toThrow("not installed");
  expect(failing.snapshot().terminals).toEqual([]);
  const copy = vi.fn();
  deps.copyText = copy;
  await new Workspace(deps).sidebarCommand({ kind: "copy-config-path" }, no);
  expect(copy).toHaveBeenCalledWith("/home/.foom/config");
});

test("config Codex launches start without notifier consent", async () => {
  deps.config = configDep();
  agents.scan.mockResolvedValue({
    ...scan,
    agents: [
      { id: "codex", path: "/bin/codex", version: "codex-cli 0.155.1", hooks: true, reason: "ok" },
    ],
  });
  const workspace = new Workspace(deps);
  const confirm = vi.fn(() => Promise.resolve(false));
  await workspace.sidebarCommand({ kind: "config-launch", run: "codex" }, confirm);
  expect(confirm).not.toHaveBeenCalled();
  expect(agents.launch).toHaveBeenCalledWith(expect.objectContaining({ agent: "codex" }));
});

test("restores config sessions only for the current config folder", async () => {
  deps.config = configDep();
  const stored = {
    id: "config-1",
    kind: "agent" as const,
    agent: "claude" as const,
    config: true,
    repository: "/home/.foom/config",
    worktree: "/home/.foom/config",
    branch: null,
    attention: "hooks" as const,
    state: null,
    dormant: true,
  };
  deps.sessions = {
    load: () =>
      Promise.resolve([
        { ...stored, conversationId: "conversation-1", running: true },
        { ...stored, id: "config-2", conversationId: "conversation-2", running: true },
        { ...stored, id: "config-shell", kind: "shell", agent: "shell", running: true },
        { ...stored, id: "moved", worktree: "/other", repository: "/other" },
        { ...stored, id: "split", repository: "/repos/app" },
      ]),
    save: () => Promise.resolve(),
    flush: () => Promise.resolve(),
  };
  const workspace = new Workspace(deps);
  await workspace.restore();
  expect(workspace.snapshot().terminals.map((entry) => entry.id)).toEqual([
    "config-1",
    "config-2",
    "config-shell",
  ]);
  agents.launch.mockImplementation((request) =>
    Promise.resolve({
      id: request.terminalId ?? "unexpected",
      attention: "hooks",
    }),
  );
  vi.spyOn(deps.terminals, "create").mockResolvedValue("config-shell");
  await workspace.restartSaved();
  expect(workspace.snapshot().terminals.every((row) => !row.exited)).toBe(true);
  expect(agents.launch).toHaveBeenCalledTimes(2);
  for (const [id, conversationId] of [
    ["config-1", "conversation-1"],
    ["config-2", "conversation-2"],
  ]) {
    expect(agents.launch).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: id, conversationId }),
    );
  }
  expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledWith(
    expect.objectContaining({ id: "config-shell" }),
  );
  await workspace.dispose();
});
