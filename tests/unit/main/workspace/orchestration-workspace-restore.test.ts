import { expect, it, vi } from "vitest";
import type { WorkspaceDependencies } from "../../../../src/main/workspace/workspace-types";
import { Operations } from "../../../../src/main/control/operations";
import {
  repo,
  main,
  child,
  scan,
  deps,
  launch,
  scans,
  stop,
  confirm,
  principal,
  createWorkspace,
} from "./orchestration-workspace-fixture";

it("restores running parents and owned children with new launches and retains history", async () => {
  const { readSessions } = await import("../../../../src/main/workspace/session-store");
  const entries = readSessions([
    {
      id: "parent",
      agent: "claude",
      repository: repo.path,
      worktree: repo.path,
      branch: "main",
      conversationId: "parent-conversation",
      running: true,
      orchestrator: {
        identity: "identity",
        history: [{ id: "old", action: "launch", label: "child", status: "succeeded", at: 1 }],
      },
    },
    {
      id: "child",
      agent: "claude",
      repository: repo.path,
      worktree: child.path,
      branch: "feature",
      conversationId: "child-conversation",
      running: true,
      parentId: "parent",
    },
    {
      id: "taken",
      agent: "claude",
      repository: repo.path,
      worktree: child.path,
      branch: "feature",
      conversationId: "taken-conversation",
      running: true,
    },
    {
      id: "exited",
      agent: "claude",
      repository: repo.path,
      worktree: child.path,
      branch: "feature",
      conversationId: "exited-conversation",
      running: false,
    },
  ]);
  const save = vi.fn<NonNullable<WorkspaceDependencies["sessions"]>["save"]>(() =>
    Promise.resolve(),
  );
  deps.sessions = { load: () => Promise.resolve(entries), save, flush: async () => {} };
  launch.mockImplementation((request) =>
    Promise.resolve({
      id: request.terminalId ?? "new",
      attention: "evaluator",
    }),
  );
  const workspace = createWorkspace(deps);
  workspace.configure({
    hooks: false,
    agents: { claude: true, codex: true, agy: true },
    agentArguments: { claude: ["--verbose"], codex: [], agy: [] },
  });
  await workspace.restore();
  expect(launch).not.toHaveBeenCalled();
  await workspace.restartSaved();
  expect(launch.mock.calls.map(([request]) => request.terminalId)).toEqual([
    "parent",
    "child",
    "taken",
  ]);
  expect(launch.mock.calls[0]?.[0]).toMatchObject({
    control: { role: "orchestrator" },
    conversationId: "parent-conversation",
    defaultArguments: ["--verbose"],
  });
  expect(launch.mock.calls[1]?.[0]).toMatchObject({
    control: { parentId: "parent" },
    conversationId: "child-conversation",
    defaultArguments: ["--verbose"],
    prompt: "Resume your previous task.",
  });
  expect(launch.mock.calls[2]?.[0].control).toBeUndefined();
  expect(confirm).not.toHaveBeenCalled();
  expect(workspace.snapshot().terminals[0]?.orchestration).toMatchObject({
    active: true,
    children: 1,
    history: [{ id: "old" }],
  });
  const operations = new Operations(
    async () => {},
    () => 1000,
  );
  const actor = { ...principal(), generation: "fresh-generation" };
  await workspace.orchestration.call(
    actor,
    "stop",
    { id: "child", idempotencyKey: "restored-stop" },
    operations,
  );
  expect(stop).toHaveBeenCalledWith("child");
  await expect(
    workspace.orchestration.call(actor, "tail", { id: "taken" }, operations),
  ).rejects.toThrow();
  workspace.orchestration.takeOver("child");
  await workspace.prepareQuit();
  expect(save.mock.calls.at(-1)?.[0].find((entry) => entry.id === "child")).not.toHaveProperty(
    "parentId",
  );
  const before = save.mock.calls.length;
  await workspace.exited("parent", 0);
  expect(save).toHaveBeenCalledTimes(before);
  await workspace.dispose();
});

it("restores a child as exited instead of spawning it with bypass defaults", async () => {
  const { readSessions } = await import("../../../../src/main/workspace/session-store");
  deps.sessions = {
    load: () =>
      Promise.resolve(
        readSessions([
          {
            id: "parent",
            agent: "claude",
            repository: repo.path,
            worktree: repo.path,
            branch: "main",
            conversationId: "parent-conversation",
            running: true,
            orchestrator: { identity: "identity", history: [] },
          },
          {
            id: "child",
            agent: "claude",
            repository: repo.path,
            worktree: child.path,
            branch: "feature",
            conversationId: "child-conversation",
            running: true,
            parentId: "parent",
          },
        ]),
      ),
    save: () => Promise.resolve(),
    flush: async () => {},
  };
  launch.mockImplementation((request) =>
    Promise.resolve({ id: request.terminalId ?? "new", attention: "evaluator" }),
  );
  const workspace = createWorkspace(deps);
  workspace.configure({
    hooks: false,
    agents: { claude: true, codex: true, agy: true },
    agentArguments: { claude: ["--dangerously-skip-permissions"], codex: [], agy: [] },
  });
  await workspace.restore();
  await workspace.restartSaved();
  expect(launch.mock.calls.map(([request]) => request.terminalId)).toEqual(["parent"]);
  expect(workspace.snapshot().terminals.find(({ id }) => id === "child")).toMatchObject({
    exited: true,
  });
  await workspace.dispose();
});

it.each(["disabled", "unverified", "identity", "failed"])(
  "restoration handles %s without inheriting authority",
  async (mode) => {
    const { readSessions } = await import("../../../../src/main/workspace/session-store");
    const entries = readSessions([
      {
        id: "parent",
        agent: "claude",
        repository: repo.path,
        worktree: repo.path,
        branch: "main",
        conversationId: "saved",
        running: true,
        orchestrator: { identity: mode === "identity" ? "old" : "identity", history: [] },
      },
    ]);
    deps.sessions = {
      load: () => Promise.resolve(entries),
      save: async () => {},
      flush: async () => {},
    };
    if (mode === "unverified") scans.current = scan(false);
    if (mode === "failed") launch.mockRejectedValue(new Error("spawn failed"));
    const workspace = createWorkspace(deps);
    workspace.configure({
      hooks: false,
      agents: { claude: true, codex: true, agy: true },
      restoreSessions: mode !== "disabled",
    });
    await workspace.restore();
    await workspace.restartSaved();
    await workspace.restartSaved();
    expect(launch).toHaveBeenCalledTimes(mode === "disabled" ? 0 : 1);
    if (mode === "disabled" || mode === "failed")
      expect(workspace.snapshot().terminals[0]).toMatchObject({
        exited: true,
        conversationId: "saved",
      });
    else {
      expect(launch.mock.calls[0]?.[0].control).toBeUndefined();
      expect(workspace.snapshot().terminals[0]).toMatchObject({ roleNotRestored: true });
    }
    await workspace.dispose();
  },
);

it.each(["shell", "home", "config", "missing", "missing-repository", "no-conversation"])(
  "restores the %s case without inventing a conversation or location",
  async (mode) => {
    const { homedir } = await import("node:os");
    const { readSessions } = await import("../../../../src/main/workspace/session-store");
    const home = homedir();
    const location = mode === "home" ? home : mode === "config" ? "/config" : repo.path;
    deps.config = { root: "/config", cliDirectory: "/cli", check: () => Promise.resolve() };
    const record = {
      id: "restored",
      agent: mode === "no-conversation" ? "claude" : "shell",
      repository: location,
      worktree: location,
      branch: mode === "home" || mode === "config" ? null : "main",
      running: true,
      ...(mode === "home" ? { home: true } : {}),
      ...(mode === "config" ? { config: true } : {}),
    };
    if (mode === "missing") record.worktree = "/gone";
    if (mode === "missing-repository") record.repository = "/unregistered";
    const saved = readSessions([record]);
    const save = vi.fn<NonNullable<WorkspaceDependencies["sessions"]>["save"]>(() =>
      Promise.resolve(),
    );
    deps.sessions = { load: () => Promise.resolve(saved), save, flush: () => Promise.resolve() };
    const create = vi.fn<WorkspaceDependencies["terminals"]["create"]>((spec) =>
      Promise.resolve(spec.id ?? "new"),
    );
    deps.terminals.create = create;
    const workspace = createWorkspace(deps);
    await workspace.restore();
    await workspace.restartSaved();
    const succeeds = ["shell", "home", "config"].includes(mode);
    expect(workspace.snapshot().terminals).toMatchObject([{ id: "restored", exited: !succeeds }]);
    expect(create).toHaveBeenCalledTimes(succeeds ? 1 : 0);
    expect(launch).not.toHaveBeenCalled();
    if (succeeds) {
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ id: "restored", cwd: location }),
      );
      // The reused ID resets the renderer row, so main's snapshot must advance with it.
      expect(workspace.snapshot().terminals[0]?.launchVersion).toBe(1);
      await workspace.exited("restored", 0);
      expect(save.mock.calls.at(-1)?.[0][0]?.running).toBe(false);
      workspace.cancelQuit();
    }
    await workspace.dispose();
  },
);

it.each([false, true])(
  "starts Codex without notifier consent during automatic restore (config=%s)",
  async (config) => {
    const { readSessions } = await import("../../../../src/main/workspace/session-store");
    scans.current = {
      path: "/bin",
      warning: null,
      agents: [
        {
          id: "codex",
          path: "/bin/codex",
          version: "codex-cli 0.161.0",
          hooks: true,
          mcp: true,
          reason: "",
        },
      ],
    };
    deps.config = { root: "/config", cliDirectory: "/cli", check: () => Promise.resolve() };
    const location = config ? "/config" : repo.path;
    const saved = readSessions([
      {
        id: "codex",
        agent: "codex",
        repository: location,
        worktree: location,
        branch: config ? null : "main",
        ...(config ? { config: true } : {}),
        running: true,
        conversationId: "saved-codex",
      },
    ]);
    deps.sessions = {
      load: () => Promise.resolve(saved),
      save: () => Promise.resolve(),
      flush: () => Promise.resolve(),
    };
    launch.mockResolvedValueOnce({ id: "codex", attention: "evaluator" });
    const workspace = createWorkspace(deps);
    await workspace.restore();
    await workspace.restartSaved();
    expect(launch).toHaveBeenCalledOnce();
    expect(workspace.snapshot().terminals).toMatchObject([
      { exited: false, conversationId: "saved-codex" },
    ]);
    await workspace.dispose();
  },
);

it("binds re-granted authority to the saved identity across asynchronous launch checks", async () => {
  const { readSessions } = await import("../../../../src/main/workspace/session-store");
  const saved = readSessions([
    {
      id: "parent",
      agent: "claude",
      repository: repo.path,
      worktree: repo.path,
      branch: "main",
      conversationId: "saved",
      running: true,
      orchestrator: { identity: "identity", history: [] },
    },
  ]);
  deps.sessions = {
    load: () => Promise.resolve(saved),
    save: () => Promise.resolve(),
    flush: () => Promise.resolve(),
  };
  vi.mocked(deps.worktrees, true)
    .launchIdentity.mockResolvedValueOnce("identity")
    .mockResolvedValue("replacement");
  const workspace = createWorkspace(deps);
  await workspace.restore();
  await workspace.restartSaved();
  expect(launch).not.toHaveBeenCalled();
  expect(workspace.snapshot().terminals).toMatchObject([
    { exited: true, conversationId: "saved", roleNotRestored: true },
  ]);
  await workspace.dispose();
});

it.each([
  "valid",
  "main",
  "foreign",
  "missing",
  "unmanaged",
  "locked",
  "bare",
  "prunable",
  "detached",
  "identity",
  "unreadable",
])("restores exited child ownership only for an eligible managed checkout: %s", async (mode) => {
  const { readSessions } = await import("../../../../src/main/workspace/session-store");
  const path = mode === "main" ? repo.path : child.path;
  const entries = readSessions([
    {
      id: "parent",
      agent: "claude",
      repository: repo.path,
      worktree: repo.path,
      branch: "main",
      conversationId: "conversation",
      running: true,
      orchestrator: {
        identity: "identity",
        history: [],
        ...(mode === "identity"
          ? { worktrees: [{ path, identity: "previous", state: "used" }] }
          : {}),
      },
    },
    {
      id: "exited-child",
      agent: "claude",
      repository: mode === "foreign" ? "/another/repo" : repo.path,
      worktree: path,
      branch: "untrusted",
      running: false,
      parentId: "parent",
    },
  ]);
  deps.sessions = {
    load: () => Promise.resolve(entries),
    save: vi.fn(() => Promise.resolve()),
    flush: async () => {},
  };
  vi.mocked(deps.worktrees.listWorktrees).mockResolvedValue([
    main,
    ...(mode === "missing" || mode === "foreign"
      ? []
      : [
          {
            ...child,
            managed: mode !== "unmanaged",
            locked: mode === "locked",
            bare: mode === "bare",
            prunable: mode === "prunable",
            branch: mode === "detached" ? null : child.branch,
          },
        ]),
  ]);
  vi.mocked(deps.worktrees.launchIdentity).mockImplementation((_repository, checkout) =>
    checkout === child.path && mode === "unreadable"
      ? Promise.reject(new Error("missing path"))
      : Promise.resolve("identity"),
  );
  const workspace = createWorkspace(deps);
  workspace.configure({ hooks: false, agents: { claude: true, codex: true, agy: true } });
  await workspace.restore();
  await workspace.restartSaved();
  const owned = workspace.orchestration.ownedWorktrees("parent");
  expect(owned).toEqual(
    mode === "valid" ? [{ path: child.path, identity: "identity", state: "used" }] : [],
  );
  if (mode === "valid") {
    await workspace.orchestration.call(
      principal(),
      "remove_worktree",
      {
        worktreeId: (await import("../../../../src/main/control/metadata")).locationId(path),
        idempotencyKey: "remove-restored",
      },
      new Operations(
        async () => {},
        () => 1000,
      ),
    );
    await vi.waitFor(() => {
      expect(deps.worktrees.removeWorktree).toHaveBeenCalled();
    });
  }
  await workspace.dispose();
});

it("reconciles remote inventory through workspace wiring without granting recovered tiles authority", async () => {
  const { readSessions } = await import("../../../../src/main/workspace/session-store");
  const checkout = {
    host: "worker",
    codeFolder: "/code",
    localRepository: repo.path,
    repository: "/code/repo",
    path: "/code/.foom-worktree-topic",
    branch: "topic",
    identity: "a".repeat(64),
  };
  const remotePath = "/foom-remote/topic";
  const saved = readSessions([
    {
      id: "parent",
      agent: "claude",
      repository: repo.path,
      worktree: repo.path,
      branch: "main",
      conversationId: "parent-conversation",
      running: true,
      orchestrator: { identity: "identity", history: [] },
    },
    {
      id: "remote-child",
      agent: "claude",
      repository: repo.path,
      worktree: remotePath,
      branch: "topic · worker",
      running: true,
      parentId: "parent",
      remote: true,
      placement: { kind: "remote", host: "worker" },
      remoteCheckout: {
        repository: checkout.repository,
        path: checkout.path,
        branch: checkout.branch,
        identity: checkout.identity,
      },
    },
  ]);
  const rememberPlacement = vi.fn();
  const hosts = {
    registered: vi.fn(() => ({ host: "worker", codeFolder: "/code" })),
    worktree: vi.fn(() =>
      Promise.resolve({ ...checkout, changes: "", sourceOrigin: "git@forge.test:me/repo.git" }),
    ),
    placement: vi.fn((path: string) => (path === remotePath ? checkout : undefined)),
    rememberPlacement,
    requireAgent: vi.fn(() => Promise.resolve()),
    fleet: vi.fn(() => Promise.resolve([])),
    sessions: vi.fn(() => Promise.resolve([{ host: "worker", session: { id: "recovered" } }])),
  };
  const save = vi.fn<NonNullable<WorkspaceDependencies["sessions"]>["save"]>(async () => {});
  const create = vi.fn<WorkspaceDependencies["terminals"]["create"]>((spec) =>
    Promise.resolve(spec.id ?? "new"),
  );
  launch.mockImplementation(async (request) => {
    if (request.reattach) request.beforeSpawn?.();
    await request.remoteCheckout?.validate();
    return { id: request.terminalId ?? "new", attention: "evaluator" };
  });
  const workspace = createWorkspace({
    ...deps,
    hosts,
    terminals: { ...deps.terminals, create },
    sessions: { load: () => Promise.resolve(saved), save, flush: async () => {} },
  });
  workspace.configure({ hooks: false, agents: { claude: true, codex: true, agy: true } });
  await workspace.restore();
  await workspace.restartSaved();
  expect(launch.mock.calls.map(([request]) => request.terminalId)).toEqual([
    "parent",
    "remote-child",
  ]);
  expect(launch.mock.calls[1]?.[0]).toMatchObject({
    reattach: true,
    terminalId: "remote-child",
    control: { parentId: "parent" },
    defaultArguments: [],
    remoteCheckout: { target: { host: "worker" }, worktree: checkout.path },
  });
  expect(create.mock.calls[0]?.[0]).toMatchObject({
    id: "recovered",
    remote: { reattach: true, human: true },
  });
  expect(deps.placeChild).toHaveBeenCalledWith("recovered", "recovered");
  expect(workspace.orchestration.view("recovered")).toBeUndefined();
  expect(workspace.orchestration.view("remote-child")).toMatchObject({
    role: "child",
    parentId: "parent",
  });
  expect(workspace.snapshot().terminals).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "remote-child", exited: false, launchVersion: 1 }),
      expect.objectContaining({ id: "recovered", exited: false, launchVersion: 1 }),
    ]),
  );
  expect(rememberPlacement).toHaveBeenCalledWith(
    repo.path,
    remotePath,
    "worker",
    expect.objectContaining({ path: checkout.path }),
  );
  expect(
    workspace.snapshot().terminals.find((row) => row.id === "remote-child"),
  ).not.toHaveProperty("remoteCheckout");
  await workspace.prepareQuit();
  expect(save.mock.calls.at(-1)?.[0].find((row) => row.id === "remote-child")).toMatchObject({
    remoteCheckout: { path: checkout.path },
  });
});

it("Close counts exited child rows still naming a restored parent", async () => {
  const { readSessions } = await import("../../../../src/main/workspace/session-store");
  const saved = {
    agent: "claude",
    repository: repo.path,
    worktree: child.path,
    branch: "feature",
    conversationId: "saved",
    running: false,
  };
  deps.sessions = {
    load: () =>
      Promise.resolve(
        readSessions([
          {
            ...saved,
            id: "parent",
            running: true,
            worktree: repo.path,
            branch: "main",
            orchestrator: { identity: "identity", history: [] },
          },
          ...["one", "two", "three"].map((id) => ({ ...saved, id, parentId: "parent" })),
          { ...saved, id: "unrelated" },
        ]),
      ),
    save: async () => {},
    flush: async () => {},
  };
  launch.mockImplementation((request) =>
    Promise.resolve({ id: request.terminalId ?? "new", attention: "evaluator" }),
  );
  const workspace = createWorkspace(deps);
  workspace.configure({ hooks: false, agents: { claude: true, codex: true, agy: true } });
  await workspace.restore();
  await workspace.restartSaved();
  await workspace.exited("parent", 0);
  await expect(workspace.sidebarCommand({ kind: "close", id: "parent" }, confirm)).rejects.toThrow(
    "foom-error:session-has-children:3",
  );
  expect(vi.spyOn(deps.terminals, "kill")).not.toHaveBeenCalled();
  expect(workspace.snapshot().terminals).toHaveLength(5);
  await workspace.sidebarCommand({ kind: "close", id: "one" }, confirm);
  await expect(workspace.sidebarCommand({ kind: "close", id: "parent" }, confirm)).rejects.toThrow(
    "foom-error:session-has-children:2",
  );
});
