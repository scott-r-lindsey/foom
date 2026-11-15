import { ENABLED_AGENTS } from "../../../helpers/enabled-agents";
import { homeDirectory } from "../../../../src/main/workspace/home-shell";
import { locationId } from "../../../../src/main/control/metadata";
import { Hosts } from "../../../../src/main/setup/hosts";
import { DEFAULT_SETTINGS } from "../../../../src/main/setup/settings";
import * as remoteTransport from "../../../../src/main/terminals/remote-transport";
import { discoverRemoteSessions } from "../../../../src/main/workspace/remote-session-restore";
import { readSessions } from "../../../../src/main/workspace/session-store";
import type { RemoteTarget } from "../../../../src/shared/remote-host";
import { expect, test, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import { machineHostName } from "../../../../src/main/workspace/sidebar-commands";
import { agents, bound, deps, tree } from "./workspace-fixture";

function configured() {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  return workspace;
}

test("machine rows are absent without hosts and follow settings order after localhost", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  expect((await workspace.sidebarInventory()).machines).toEqual([]);
  const fleet = vi.fn().mockResolvedValue([
    {
      host: "user@dozer.local",
      result: {
        ok: true,
        facts: {
          agents: [
            { id: "codex", state: "ready" },
            { id: "claude", state: "missing" },
          ],
        },
      },
    },
    { host: "offline", result: { ok: false, reason: "unreachable" } },
  ]);
  deps.hosts = {
    fleet,
    registered: vi.fn(),
    requireAgent: vi.fn(),
    worktree: vi.fn(),
    locationsForSidebar: vi.fn().mockResolvedValue({
      locations: [
        {
          host: "user@dozer.local",
          repository: "/repo",
          result: { ok: true, checkout: { state: "clean" } },
        },
        {
          host: "user@dozer.local",
          repository: "/absent",
          result: { ok: true, checkout: { state: "absent" } },
        },
        { host: "offline", repository: "/failed", result: { ok: false } },
      ],
    }),
  };
  const inventory = await configured().sidebarInventory();
  expect(inventory.machines).toEqual([
    {
      host: null,
      name: "localhost",
      available: true,
      agents: [{ id: "claude", name: "Claude Code" }],
    },
    {
      host: "user@dozer.local",
      name: "dozer",
      available: true,
      repositories: ["/repo"],
      agents: [{ id: "codex", name: "Codex" }],
    },
    { host: "offline", name: "offline", available: false, repositories: [], agents: [] },
  ]);
  expect(machineHostName("dozer")).toBe("dozer");
  expect(machineHostName("me@192.168.1.2")).toBe("192.168.1.2");
  vi.mocked(deps.hosts.registered).mockImplementation((host) => ({
    host,
    codeFolder: "/code",
    ...(host.includes("dozer") ? { nickname: "Build box" } : {}),
  }));
  expect((await configured().sidebarInventory()).machines?.[1]?.name).toBe("Build box");
});

test("local machine launches use the installed CLI and user defaults without creating an orchestration child", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  const created = await workspace.sidebarCommand(
    { kind: "machine-launch", host: null, run: "claude" },
    () => Promise.resolve(true),
  );
  expect(created).toEqual({ terminalId: "t1" });
  expect(agents.launch).toHaveBeenCalledWith(
    expect.objectContaining({
      repository: homeDirectory,
      worktree: homeDirectory,
      humanHome: true,
      localOnly: true,
      agent: "claude",
      defaultArguments: [],
    }),
  );
  expect(vi.spyOn(deps.terminals, "create")).not.toHaveBeenCalled();
  expect(workspace.snapshot().terminals).toEqual([
    expect.objectContaining({
      agent: "claude",
      home: true,
      machine: true,
      placement: { kind: "local" },
    }),
  ]);
  await expect(
    workspace.sidebarCommand({ kind: "machine-launch", host: null, run: "codex" }, () =>
      Promise.resolve(true),
    ),
  ).rejects.toThrow();
});

test.each(["shell", "claude"] as const)(
  "remote machine %s launch records the daemon home and sends no hub environment",
  async (run) => {
    deps.hosts = {
      fleet: vi.fn(),
      registered: vi.fn(() => ({ host: "dozer", codeFolder: "/home/fixture/code" })),
      requireAgent: vi.fn(),
      worktree: vi.fn(),
      shellTarget: vi.fn(
        (): RemoteTarget => ({ host: "dozer", profile: "a".repeat(32), human: true }),
      ),
    };
    vi.spyOn(deps.terminals, "create").mockImplementationOnce((spec) => {
      spec.remote?.machineHome?.("/home/remote-user");
      return Promise.resolve("t1");
    });
    const workspace = new Workspace(deps);
    workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
    await workspace.sidebarCommand({ kind: "machine-launch", host: "dozer", run }, () =>
      Promise.resolve(true),
    );
    if (run !== "shell") expect(deps.hosts.requireAgent).toHaveBeenCalledWith("dozer", run);
    expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {},
      }),
    );
    expect(vi.spyOn(deps.terminals, "create").mock.calls[0]?.[0].remote).toMatchObject({
      host: "dozer",
      profile: "a".repeat(32),
      human: true as const,
      machine: {
        codeFolder: "/home/fixture/code",
        ...(run === "shell" ? {} : { agent: run, defaults: [] }),
      },
      context: {
        repository: homeDirectory,
        worktree: homeDirectory,
        branch: null,
        agent: run,
        machine: true,
      },
    });
    expect(workspace.snapshot().terminals[0]).toMatchObject({
      machine: true,
      agent: run,
      repository: "/home/remote-user",
      worktree: "/home/remote-user",
      placement: { kind: "remote", host: "dozer" },
    });
  },
);

test("machine shells restart on their selected machine and local agents resume through the ordinary human launcher", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  await workspace.sidebarCommand({ kind: "machine-launch", host: null, run: "shell" }, () =>
    Promise.resolve(true),
  );
  expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledWith(
    expect.objectContaining({ shellIntegration: true, cwd: homeDirectory }),
  );
  await workspace.exited("t1", 0);
  await workspace.sidebarCommand({ kind: "restart", id: "t1" }, () => Promise.resolve(true));
  expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledTimes(2);
});

test("resuming a local machine agent preserves its conversation without another hook", async () => {
  const save = vi.fn(() => Promise.resolve());
  deps.sessions = { load: () => Promise.resolve([]), save, flush: () => Promise.resolve() };
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  await workspace.sidebarCommand({ kind: "machine-launch", host: null, run: "claude" }, () =>
    Promise.resolve(true),
  );
  await workspace.hook({
    terminalId: await bound(),
    action: "needs_input",
    signal: "plugin:claude:PermissionRequest",
    conversationId: "saved-conversation",
  });
  await workspace.exited("t1", 0);
  // Resumed v2 launches return no conversation ID; only new conversations generate one.
  agents.launch.mockResolvedValue({ id: "t1", attention: "evaluator" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await workspace.sidebarCommand({ kind: "resume", id: "t1" }, () => Promise.resolve(true));
    expect(agents.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ terminalId: "t1", conversationId: "saved-conversation" }),
    );
    expect(workspace.snapshot().terminals[0]).toMatchObject({
      id: "t1",
      conversationId: "saved-conversation",
      exited: false,
    });
    expect(save).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "t1", conversationId: "saved-conversation", running: true }),
    ]);
    await workspace.exited("t1", 0);
  }
  await workspace.dispose();
});

test("disabled agents, missing hosts and failed remote readiness create no terminal", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  workspace.configure({ hooks: false, agents: { claude: false, codex: true, agy: false } });
  await expect(
    workspace.sidebarCommand({ kind: "machine-launch", host: null, run: "claude" }, () =>
      Promise.resolve(true),
    ),
  ).rejects.toThrow("turned off");
  await expect(
    workspace.sidebarCommand({ kind: "machine-launch", host: "unregistered", run: "shell" }, () =>
      Promise.resolve(true),
    ),
  ).rejects.toThrow();
  expect(vi.spyOn(deps.terminals, "create")).not.toHaveBeenCalled();
});

test("repository-launch uses the checked remote clone without an orchestration grant", async () => {
  const kind = "repository-launch" as const;
  const { repo } = await import("./workspace-fixture");
  const remote: RemoteTarget = {
    host: "dozer",
    profile: "a".repeat(32),
    human: true as const,
    machine: {
      codeFolder: "/code",
      repository: {
        directory: `repository-${"a".repeat(24)}`,
        origin: "git@fixture.test:team/repo.git",
      },
    },
  };
  deps.hosts = {
    fleet: vi.fn(),
    registered: vi.fn(() => ({ host: "dozer", codeFolder: "/code" })),
    requireAgent: vi.fn(),
    worktree: vi.fn(),
    shellTarget: vi.fn((): RemoteTarget => ({ host: "dozer", human: true as const })),
    repositoryTarget: vi.fn(() => Promise.resolve(remote)),
  };
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  await workspace.sidebarCommand(
    { kind, repository: repo.path, host: "dozer", run: "claude" },
    () => Promise.resolve(true),
  );
  const row = workspace.snapshot().terminals[0];
  expect(row).toMatchObject({
    repository: repo.path,
    branch: "Main checkout",
    placement: { kind: "remote", host: "dozer" },
  });
  expect(row?.home).toBeUndefined();
  expect(row?.machine).toBeUndefined();
  expect(row?.orchestration).toBeUndefined();
  expect(row?.worktree).toMatch(/^\/foom-remote\//);
  const opened = vi.spyOn(deps.terminals, "create").mock.calls[0]?.[0];
  expect(opened?.remote?.human).toBe(true);
  expect(opened?.remote?.agent).toBeUndefined();
  await workspace.exited("t1", 0);
  await workspace.sidebarCommand({ kind: "new-conversation", id: "t1" }, () =>
    Promise.resolve(true),
  );
  expect(vi.spyOn(deps.terminals, "kill")).toHaveBeenCalledWith("t1", "dozer");
});

test("remote worktree creation validates the branch, records placement and launches nothing", async () => {
  const { repo } = await import("./workspace-fixture");
  const rememberPlacement = vi.fn();
  deps.hosts = {
    fleet: vi.fn(),
    registered: vi.fn(),
    requireAgent: vi.fn(),
    worktree: vi.fn(() =>
      Promise.resolve({
        repository: "/code/repository-clone",
        path: "/code/.foom-worktree-new",
        branch: "new-branch",
        identity: "a".repeat(64),
        changes: "",
        sourceOrigin: "git@fixture.test:team/repo.git",
      }),
    ),
    rememberPlacement,
  };
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  const created = await workspace.createWorktree(repo.path, "new-branch", undefined, "dozer");
  expect(created).toMatchObject({ host: "dozer", branch: "new-branch", outcome: "new" });
  expect(rememberPlacement).toHaveBeenCalledWith(
    repo.path,
    created.path,
    "dozer",
    expect.objectContaining({ identity: "a".repeat(64) }),
  );
  expect(agents.launch).not.toHaveBeenCalled();
  expect(vi.spyOn(deps.terminals, "create")).not.toHaveBeenCalled();
});

test("failed replacement of a machine agent retains its dormant session for retry", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  await workspace.sidebarCommand({ kind: "machine-launch", host: null, run: "claude" }, () =>
    Promise.resolve(true),
  );
  await workspace.exited("t1", 0);
  agents.launch.mockRejectedValueOnce(new Error("launch failed"));
  await expect(
    workspace.sidebarCommand({ kind: "new-conversation", id: "t1" }, () => Promise.resolve(true)),
  ).rejects.toThrow("launch failed");
  expect(workspace.snapshot().terminals[0]).toMatchObject({
    id: "t1",
    machine: true,
    dormant: true,
    exited: true,
  });
});

function remoteMainFixture() {
  deps.hosts = {
    fleet: vi.fn(),
    registered: vi.fn((host: string) => ({ host, codeFolder: "/code" })),
    requireAgent: vi.fn(),
    worktree: vi.fn(),
    shellTarget: vi.fn((host: string): RemoteTarget => ({ host, human: true })),
    repositoryTarget: vi.fn(
      (host: string): Promise<RemoteTarget> =>
        Promise.resolve({
          host,
          human: true,
          machine: {
            codeFolder: "/code",
            repository: { directory: "repository-clone", origin: "git@fixture.test:team/repo.git" },
          },
        }),
    ),
  };
  const create = vi.spyOn(deps.terminals, "create");
  let sequence = 0;
  create.mockImplementation(() => Promise.resolve(`remote-${String(++sequence)}`));
  return { workspace: configured(), create };
}

test("repository-launch confirms sharing a remote main checkout before creating another PTY", async () => {
  const kind = "repository-launch" as const;
  const { repo } = await import("./workspace-fixture");
  const { workspace, create } = remoteMainFixture();
  const command = { kind, repository: repo.path, host: "dozer", run: "claude" } as const;
  await workspace.sidebarCommand(command, () => Promise.resolve(true));
  const deny = vi.fn(() => Promise.resolve(false));
  expect(await workspace.sidebarCommand(command, deny)).toBeUndefined();
  expect(deny).toHaveBeenCalledExactlyOnceWith({ kind: "shared-agent" });
  expect(create).toHaveBeenCalledTimes(1);
  await workspace.sidebarCommand(command, () => Promise.resolve(true));
  expect(create).toHaveBeenCalledTimes(2);
});

test("remote main-checkout shells restart on their host without local identity validation", async () => {
  const { repo } = await import("./workspace-fixture");
  const { workspace, create } = remoteMainFixture();
  await workspace.sidebarCommand(
    { kind: "repository-launch", repository: repo.path, host: "dozer", run: "claude" },
    () => Promise.resolve(true),
  );
  const worktree = workspace.snapshot().terminals[0]?.worktree;
  if (!worktree) throw new Error("Missing remote checkout");
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree, run: "shell" },
    () => Promise.resolve(true),
  );
  await workspace.exited("remote-2", 0);
  const identity = vi.spyOn(deps.worktrees, "launchIdentity");
  identity.mockRejectedValue(new Error("Synthetic path is not local"));
  await workspace.sidebarCommand({ kind: "restart", id: "remote-2" }, () => Promise.resolve(true));
  expect(identity).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(3);
  expect(create.mock.calls[2]?.[0].remote).toMatchObject({
    host: "dozer",
    machine: { repository: { directory: "repository-clone" } },
  });
  expect(workspace.snapshot().terminals.map((row) => row.id)).toEqual(["remote-1", "remote-3"]);
});

test("remote main-checkout launch locks cover confirmation and spawn and release after failure", async () => {
  const { repo } = await import("./workspace-fixture");
  const { workspace, create } = remoteMainFixture();
  const command = {
    kind: "repository-launch",
    repository: repo.path,
    host: "dozer",
    run: "claude",
  } as const;
  const spawning = Promise.withResolvers<string>();
  const entered = Promise.withResolvers<undefined>();
  create.mockImplementationOnce(() => {
    entered.resolve(undefined);
    return spawning.promise;
  });
  const first = workspace.sidebarCommand(command, () => Promise.resolve(true));
  await entered.promise;
  await expect(workspace.sidebarCommand(command, () => Promise.resolve(true))).rejects.toThrow(
    "busy",
  );
  spawning.reject(new Error("spawn failed"));
  await expect(first).rejects.toThrow("spawn failed");
  await workspace.sidebarCommand(command, () => Promise.resolve(true));
  const confirming = Promise.withResolvers<boolean>();
  const asked = Promise.withResolvers<undefined>();
  const second = workspace.sidebarCommand(command, () => {
    asked.resolve(undefined);
    return confirming.promise;
  });
  await asked.promise;
  await expect(workspace.sidebarCommand(command, () => Promise.resolve(true))).rejects.toThrow(
    "busy",
  );
  confirming.resolve(false);
  expect(await second).toBeUndefined();
  await workspace.sidebarCommand(command, () => Promise.resolve(true));
  expect(create).toHaveBeenCalledTimes(3);
});

test("remote main-checkout sharing guards panel launches and replacements without mixing hosts or exited agents", async () => {
  const { repo } = await import("./workspace-fixture");
  const { workspace, create } = remoteMainFixture();
  const command = {
    kind: "repository-launch",
    repository: repo.path,
    host: "dozer",
    run: "claude",
  } as const;
  await workspace.sidebarCommand(command, () => Promise.resolve(true));
  const worktree = workspace.snapshot().terminals[0]?.worktree;
  if (!worktree) throw new Error("Missing remote checkout");
  const deny = vi.fn(() => Promise.resolve(false));
  await workspace.sidebarCommand(
    { kind: "launch", repository: repo.path, worktree, run: "claude" },
    deny,
  );
  expect(create).toHaveBeenCalledTimes(1);
  await workspace.sidebarCommand({ ...command, host: "other" }, deny);
  expect(deny).toHaveBeenCalledTimes(1);
  await workspace.sidebarCommand(command, () => Promise.resolve(true));
  await workspace.exited("remote-1", 0);
  await workspace.sidebarCommand({ kind: "new-conversation", id: "remote-1" }, deny);
  expect(deny).toHaveBeenCalledTimes(2);
  expect(vi.spyOn(deps.terminals, "kill")).not.toHaveBeenCalled();
  await workspace.exited("remote-3", 0);
  await workspace.sidebarCommand({ ...command, run: "shell" }, deny);
  await workspace.sidebarCommand(command, deny);
  expect(deny).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenCalledTimes(5);
});

function remoteLinkedFixture() {
  const repository = "/repos/app";
  const checkout = {
    host: "dozer",
    codeFolder: "/code",
    localRepository: repository,
    repository: "/code/repository-clone",
    path: "/code/.foom-worktree-topic",
    branch: "topic",
    identity: "a".repeat(64),
  };
  const worktree = `/foom-remote/${locationId(JSON.stringify([checkout.host, checkout.path]))}`;
  deps.hosts = {
    fleet: vi.fn(),
    registered: vi.fn(() => ({ host: checkout.host, codeFolder: checkout.codeFolder })),
    requireAgent: vi.fn(),
    worktree: vi.fn(() => Promise.resolve({ ...checkout, changes: "", sourceOrigin: "origin" })),
    placement: vi.fn(() => checkout),
    worktrees: vi.fn(() =>
      Promise.resolve([{ ...tree, path: worktree, branch: checkout.branch, host: checkout.host }]),
    ),
    shellTarget: vi.fn((): RemoteTarget => ({ host: checkout.host, human: true })),
  };
  return { repository, worktree, branch: "topic", checkout };
}

test.each(["claude", "codex"] as const)(
  "orphaned remote %s Resume forwards the saved conversation into the remote launch argv",
  async (agent) => {
    const location = remoteLinkedFixture();
    const save = vi.fn(async () => {});
    deps.sessions = {
      load: () =>
        Promise.resolve(
          readSessions([
            {
              id: "t1",
              agent,
              repository: location.repository,
              worktree: location.worktree,
              branch: location.branch,
              conversationId: "saved-conversation",
              remote: true,
              placement: { kind: "remote", host: "dozer" },
              running: false,
            },
          ]),
        ),
      save,
      flush: async () => {},
    };
    const workspace = new Workspace(deps);
    workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
    await workspace.restore();
    expect(workspace.snapshot().terminals[0]?.orchestration).toBeUndefined();
    await workspace.sidebarCommand({ kind: "resume", id: "t1" }, () => Promise.resolve(true));
    const create = vi.spyOn(deps.terminals, "create");
    expect(create.mock.calls.at(-1)?.[0].remote?.machine).toMatchObject({
      agent,
      defaults:
        agent === "claude" ? ["--resume", "saved-conversation"] : ["resume", "saved-conversation"],
    });
    expect(workspace.snapshot().terminals[0]).toMatchObject({
      conversationId: "saved-conversation",
      exited: false,
    });
    expect(save).toHaveBeenLastCalledWith([
      expect.objectContaining({ conversationId: "saved-conversation", running: true }),
    ]);
    await workspace.exited("t1", 0);
    await workspace.sidebarCommand({ kind: "new-conversation", id: "t1" }, () =>
      Promise.resolve(true),
    );
    expect(create.mock.calls.at(-1)?.[0].remote?.machine?.defaults).toEqual([]);
    expect(workspace.snapshot().terminals[0]?.conversationId).toBeUndefined();
    await workspace.dispose();
  },
);

test("human linked-checkout launches recover as repository agents from daemon inventory before checkout inventory is warm", async () => {
  const location = remoteLinkedFixture();
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  await workspace.sidebarCommand(
    { kind: "launch", repository: location.repository, worktree: location.worktree, run: "claude" },
    () => Promise.resolve(true),
  );
  const target = vi.spyOn(deps.terminals, "create").mock.calls[0]?.[0].remote;
  if (!target?.context || !target.checkout) throw new Error("Missing remote session context");
  const settings = {
    ...DEFAULT_SETTINGS,
    registeredHosts: [{ host: "dozer", codeFolder: "/code" }],
  };
  const inventory = vi.spyOn(remoteTransport, "remoteInventory").mockResolvedValue({
    type: "inventory-result",
    own: [{ id: "t1", context: target.context, checkout: target.checkout }],
    foreign: [],
  });
  const hosts = new Hosts(
    { get: () => settings, update: vi.fn() },
    () => [{ path: location.repository, name: "app" }],
    "0.1.0",
    vi.fn(),
    "a".repeat(32),
  );
  // A fresh host service has neither remembered local rows nor checkout inventory.
  expect(hosts.placement(location.worktree)).toBeUndefined();
  const recovered = await discoverRemoteSessions(hosts);
  expect(inventory).toHaveBeenCalledOnce();
  expect(recovered).toEqual([
    expect.objectContaining({
      agent: "claude",
      kind: "agent",
      repository: location.repository,
      worktree: location.worktree,
      remoteCheckout: {
        repository: location.checkout.repository,
        path: location.checkout.path,
        branch: location.branch,
        identity: location.checkout.identity,
      },
    }),
  ]);
  expect(recovered[0]?.home).toBeUndefined();
  expect(hosts.placement(location.worktree)?.localRepository).toBe(location.repository);
  await workspace.dispose();
});

test("startup begins before agent discovery and cancellation prevents the local spawn", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  const controller = new AbortController();
  const started = vi.fn();
  const discovered = await agents.scan();
  let finish = () => {};
  agents.scan.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => {
          resolve(discovered);
        };
      }),
  );
  const pending = workspace.sidebarCommand(
    { kind: "machine-launch", host: null, run: "claude" },
    () => Promise.resolve(true),
    { signal: controller.signal, started },
  );
  expect(started).toHaveBeenCalledOnce();
  expect(agents.launch).not.toHaveBeenCalled();
  controller.abort();
  finish();
  await expect(pending).rejects.toThrow();
  expect(agents.launch).not.toHaveBeenCalled();
  expect(workspace.snapshot().terminals).toEqual([]);
});

test("startup cancellation before dispatch creates no terminal or startup notification", async () => {
  const workspace = new Workspace(deps);
  workspace.configure({ hooks: true, agents: ENABLED_AGENTS });
  const controller = new AbortController();
  controller.abort();
  const started = vi.fn();
  await expect(
    workspace.sidebarCommand(
      { kind: "machine-launch", host: null, run: "shell" },
      () => Promise.resolve(true),
      { signal: controller.signal, started },
    ),
  ).rejects.toThrow();
  expect(started).not.toHaveBeenCalled();
  expect(workspace.snapshot().terminals).toEqual([]);
});

test("remote startup preserves its sharing warning before publishing startup, including denial", async () => {
  const { repo } = await import("./workspace-fixture");
  const { workspace, create } = remoteMainFixture();
  const command = {
    kind: "repository-launch",
    repository: repo.path,
    host: "dozer",
    run: "claude",
  } as const;
  await workspace.sidebarCommand(command, () => Promise.resolve(true));
  const controller = new AbortController();
  const started = vi.fn();
  const confirm = vi.fn(() => Promise.resolve(false));
  expect(
    await workspace.sidebarCommand(command, confirm, { signal: controller.signal, started }),
  ).toBeUndefined();
  expect(confirm).toHaveBeenCalledExactlyOnceWith({ kind: "shared-agent" });
  expect(started).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(1);
  confirm.mockResolvedValue(true);
  await workspace.sidebarCommand(command, confirm, { signal: controller.signal, started });
  expect(started).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledTimes(2);
});

test("startup cleanup removes only its new remote session and retains a failed cleanup for retry", async () => {
  const { repo } = await import("./workspace-fixture");
  const { workspace } = remoteMainFixture();
  const result = await workspace.sidebarCommand(
    { kind: "repository-launch", repository: repo.path, host: "dozer", run: "shell" },
    () => Promise.resolve(true),
  );
  if (!result) throw new Error("Missing created session");
  const kill = vi.spyOn(deps.terminals, "kill");
  kill.mockRejectedValueOnce(new Error("unreachable"));
  await expect(workspace.cancelStartup(result.terminalId)).rejects.toThrow("unreachable");
  expect(workspace.snapshot().terminals).toHaveLength(1);
  await workspace.cancelStartup(result.terminalId);
  expect(kill).toHaveBeenLastCalledWith(result.terminalId, "dozer");
  expect(workspace.snapshot().terminals).toHaveLength(0);
  await workspace.cancelStartup(result.terminalId);
  expect(kill).toHaveBeenCalledTimes(2);
});

test("startup sharing keeps the remote launch reservation until confirmation and spawning settle", async () => {
  const { repo } = await import("./workspace-fixture");
  const { workspace, create } = remoteMainFixture();
  const command = {
    kind: "repository-launch",
    repository: repo.path,
    host: "dozer",
    run: "claude",
  } as const;
  await workspace.sidebarCommand(command, () => Promise.resolve(true));
  const confirmation = Promise.withResolvers<boolean>();
  const asked = Promise.withResolvers<undefined>();
  const started = vi.fn();
  const pending = workspace.sidebarCommand(
    command,
    () => {
      asked.resolve(undefined);
      return confirmation.promise;
    },
    { signal: new AbortController().signal, started },
  );
  await asked.promise;
  expect(started).not.toHaveBeenCalled();
  await expect(workspace.sidebarCommand(command, () => Promise.resolve(true))).rejects.toThrow(
    "busy",
  );
  const spawning = Promise.withResolvers<string>();
  const entered = Promise.withResolvers<undefined>();
  create.mockImplementationOnce(() => {
    entered.resolve(undefined);
    return spawning.promise;
  });
  confirmation.resolve(true);
  await entered.promise;
  expect(started).toHaveBeenCalledOnce();
  await expect(workspace.sidebarCommand(command, () => Promise.resolve(true))).rejects.toThrow(
    "busy",
  );
  spawning.resolve("second");
  await pending;
  await workspace.sidebarCommand(command, () => Promise.resolve(true));
  expect(create).toHaveBeenCalledTimes(3);
});

test.each([false, true])(
  "a first remote repository launch never shares with a local main-checkout agent (startup=%s)",
  async (startup) => {
    const { repo } = await import("./workspace-fixture");
    vi.spyOn(deps.worktrees, "listWorktrees").mockResolvedValue([
      { ...tree, path: repo.path, branch: "main" },
    ]);
    const { workspace, create } = remoteMainFixture();
    await workspace.sidebarCommand(
      { kind: "repository-launch", repository: repo.path, host: null, run: "claude" },
      () => Promise.resolve(false),
    );
    expect(workspace.snapshot().terminals).toEqual([
      expect.objectContaining({ worktree: repo.path, agent: "claude" }),
    ]);
    const confirm = vi.fn(() => Promise.resolve(false));
    const started = vi.fn();
    const result = await workspace.sidebarCommand(
      { kind: "repository-launch", repository: repo.path, host: "dozer", run: "claude" },
      confirm,
      startup ? { signal: new AbortController().signal, started } : undefined,
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(result).toEqual({ terminalId: "remote-1" });
    expect(workspace.snapshot().terminals.find((row) => row.id === "remote-1")).toMatchObject({
      worktree: `/foom-remote/${locationId(JSON.stringify(["dozer", "/code/repository-clone"]))}`,
      placement: { kind: "remote", host: "dozer" },
    });
    expect(started).toHaveBeenCalledTimes(startup ? 1 : 0);
  },
);

test("startup sharing checks the resolved remote clone instead of an older session's checkout", async () => {
  const { repo } = await import("./workspace-fixture");
  const { workspace, create } = remoteMainFixture();
  const command = {
    kind: "repository-launch",
    repository: repo.path,
    host: "dozer",
    run: "claude",
  } as const;
  await workspace.sidebarCommand(command, () => Promise.resolve(true));
  if (!deps.hosts) throw new Error("Missing hosts");
  vi.spyOn(deps.hosts, "repositoryTarget").mockResolvedValue({
    host: "dozer",
    human: true,
    machine: {
      codeFolder: "/code",
      repository: { directory: "moved-clone", origin: "git@fixture.test:team/repo.git" },
    },
  });
  const confirm = vi.fn(() => Promise.resolve(false));
  const started = vi.fn();
  const result = await workspace.sidebarCommand(command, confirm, {
    signal: new AbortController().signal,
    started,
  });
  expect(confirm).not.toHaveBeenCalled();
  expect(started).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledTimes(2);
  expect(result).toEqual({ terminalId: "remote-2" });
});
