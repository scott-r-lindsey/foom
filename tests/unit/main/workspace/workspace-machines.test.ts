import type { RemoteTarget } from "../../../../src/shared/remote-host";
import { expect, test, vi } from "vitest";
import { Workspace } from "../../../../src/main/workspace/workspace";
import { machineHostName } from "../../../../src/main/workspace/sidebar-commands";
import { agents, deps } from "./workspace-fixture";

test("machine rows are absent without hosts and follow settings order after localhost", async () => {
  const workspace = new Workspace(deps);
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
  const inventory = await new Workspace(deps).sidebarInventory();
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
});

test("local machine launches use the installed CLI and user defaults without creating an orchestration child", async () => {
  const workspace = new Workspace(deps);
  const created = await workspace.sidebarCommand(
    { kind: "machine-launch", host: null, run: "claude" },
    () => Promise.resolve(true),
  );
  expect(created).toEqual({ terminalId: "t1" });
  expect(agents.launch).toHaveBeenCalledWith(
    expect.objectContaining({
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

test("remote machine launch validates registration and installed agents and sends no hub environment", async () => {
  deps.hosts = {
    fleet: vi.fn(),
    registered: vi.fn(() => ({ host: "dozer", codeFolder: "/home/fixture/code" })),
    requireAgent: vi.fn(),
    worktree: vi.fn(),
    shellTarget: vi.fn(
      (): RemoteTarget => ({ host: "dozer", profile: "a".repeat(32), human: true }),
    ),
  };
  const workspace = new Workspace(deps);
  await workspace.sidebarCommand({ kind: "machine-launch", host: "dozer", run: "claude" }, () =>
    Promise.resolve(true),
  );
  expect(deps.hosts.requireAgent).toHaveBeenCalledWith("dozer", "claude");
  expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledWith(
    expect.objectContaining({
      env: {},
    }),
  );
  expect(vi.spyOn(deps.terminals, "create").mock.calls[0]?.[0].remote).toMatchObject({
    host: "dozer",
    profile: "a".repeat(32),
    human: true as const,
    machine: { codeFolder: "/home/fixture/code", agent: "claude", defaults: [] },
    context: {
      repository: "/home/fixture/code",
      worktree: "/home/fixture/code",
      branch: null,
      agent: "claude",
      machine: true,
    },
  });
  expect(workspace.snapshot().terminals[0]).toMatchObject({
    machine: true,
    agent: "claude",
    placement: { kind: "remote", host: "dozer" },
  });
});

test("machine shells restart on their selected machine and local agents resume through the ordinary human launcher", async () => {
  const workspace = new Workspace(deps);
  await workspace.sidebarCommand({ kind: "machine-launch", host: null, run: "shell" }, () =>
    Promise.resolve(true),
  );
  expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledWith(
    expect.objectContaining({ shellIntegration: true }),
  );
  await workspace.exited("t1", 0);
  await workspace.sidebarCommand({ kind: "restart", id: "t1" }, () => Promise.resolve(true));
  expect(vi.spyOn(deps.terminals, "create")).toHaveBeenCalledTimes(2);
});

test("disabled agents, missing hosts and failed remote readiness create no terminal", async () => {
  const workspace = new Workspace(deps);
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

test("repository agent placement uses the checked remote clone without an orchestration grant", async () => {
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
  await workspace.sidebarCommand(
    { kind: "repository-launch", repository: repo.path, host: "dozer", run: "claude" },
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
