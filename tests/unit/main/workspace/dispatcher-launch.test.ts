import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ENABLED_AGENTS } from "../../../helpers/enabled-agents";
import { git } from "../../../helpers/git.js";
import { Dispatcher } from "../../../../src/main/control/dispatcher";
import { ControlRuntime } from "../../../../src/main/control/runtime";
import { expect, test, vi } from "vitest";
import type { WorkspaceDependencies } from "../../../../src/main/workspace/workspace-types";
import type { AgentLaunch } from "../../../../src/shared/agents";
import type { DispatcherLaunch } from "../../../../src/shared/dispatcher";
import {
  confirm,
  createWorkspace,
  deps,
  launch,
  repo,
  scans,
  stop,
} from "./orchestration-workspace-fixture";

const proof = { path: repo.path, identity: "identity", name: "app" };
const launchRequest: DispatcherLaunch = {
  repo: "app",
  agent: "claude",
  idempotencyKey: "launch",
  prompt: "Review the release.",
};
const lifecycle = { terminalId: "orchestrator", spawning() {}, binding() {} };

test("dispatcher launches use the ordinary orchestrator slot and recheck scope before spawn", async () => {
  scans.current = {
    ...scans.current,
    agents: scans.current.agents.map((agent) => ({ ...agent, initialPrompt: true })),
  };
  const workspace = createWorkspace();
  const verify = vi.fn(() => Promise.resolve());
  const active = vi.fn();
  const launchLifecycle = { ...lifecycle, spawning: vi.fn(), binding: vi.fn() };
  launch.mockImplementationOnce(async (request) => {
    await request.prepareSpawn?.();
    request.beforeSpawn?.();
    if (request.control && "role" in request.control) request.control.beforeBind?.("orchestrator");
    expect(workspace.orchestration.active(repo.path)).toBe("orchestrator");
    return { id: "orchestrator", attention: "evaluator" };
  });
  await expect(
    workspace.dispatcherHost.launch(
      launchRequest,
      proof,
      "dispatcher",
      verify,
      active,
      launchLifecycle,
    ),
  ).resolves.toBe("orchestrator");
  expect(verify).toHaveBeenCalledTimes(3);
  expect(active).toHaveBeenCalledTimes(3);
  expect(launchLifecycle.spawning).toHaveBeenCalledOnce();
  expect(launchLifecycle.binding).toHaveBeenCalledExactlyOnceWith("orchestrator");
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({
      repository: repo.path,
      worktree: repo.path,
      terminalId: "orchestrator",
      automated: true,
      localOnly: true,
      prompt: launchRequest.prompt,
    }),
  );
  expect(launch.mock.calls[0]?.[0].control).toMatchObject({ role: "orchestrator" });
  expect(workspace.orchestration.active(repo.path)).toBe("orchestrator");
  expect(deps.placeChild).toHaveBeenCalledWith("orchestrator", "dispatcher");
  await expect(
    workspace.dispatcherHost.launch(launchRequest, proof, "dispatcher", verify, active, lifecycle),
  ).rejects.toThrow("conflict");
  expect(launch).toHaveBeenCalledOnce();
});

test("a failed launch releases an orchestrator slot already bound for startup", async () => {
  scans.current = {
    ...scans.current,
    agents: scans.current.agents.map((agent) => ({ ...agent, initialPrompt: true })),
  };
  const workspace = createWorkspace();
  launch.mockImplementationOnce((request) => {
    request.beforeSpawn?.();
    if (request.control && "role" in request.control) request.control.beforeBind?.("failed");
    return Promise.reject(new Error("Launch failed"));
  });
  await expect(
    workspace.dispatcherHost.launch(
      launchRequest,
      proof,
      "dispatcher",
      () => Promise.resolve(),
      vi.fn(),
      { ...lifecycle, terminalId: "failed" },
    ),
  ).rejects.toThrow("Launch failed");
  expect(workspace.orchestration.active(repo.path)).toBeUndefined();
});

test("dispatcher remote launch binds the selected host and its verified repository origin", async () => {
  const folder = "/work/code";
  const clone = "repository-fixture";
  const origin = "https://example.test/project.git";
  const hosts: NonNullable<WorkspaceDependencies["hosts"]> = {
    registered: vi.fn((host: string) => ({ host, codeFolder: folder })),
    requireAgent: vi.fn(() => Promise.resolve()),
    worktree: vi.fn(),
    fleet: vi.fn(() => Promise.resolve([])),
    repositoryTarget: vi.fn(
      async (host: string, _repository: string, authorize?: () => void | Promise<void>) => {
        await authorize?.();
        return {
          host,
          profile: "fixture",
          machine: { codeFolder: folder, repository: { directory: clone, origin } },
        };
      },
    ),
  };
  const workspace = createWorkspace({ ...deps, hosts });
  const verify = vi.fn(() => Promise.resolve());
  const active = vi.fn();
  let mapped: AgentLaunch["remoteOrchestrator"];
  launch.mockImplementationOnce(async (request) => {
    mapped = request.remoteOrchestrator;
    await mapped?.validate();
    request.beforeSpawn?.();
    return { id: "orchestrator", attention: "evaluator" };
  });
  await expect(
    workspace.dispatcherHost.launch(
      { ...launchRequest, host: "worker" },
      proof,
      "dispatcher",
      verify,
      active,
      lifecycle,
    ),
  ).resolves.toBe("orchestrator");
  expect(mapped).toMatchObject({ path: `${folder}/${clone}`, origin, target: { host: "worker" } });
  expect(hosts.requireAgent).toHaveBeenCalledExactlyOnceWith("worker", "claude");
  expect(hosts.registered).toHaveBeenCalledWith("worker", folder);
  expect(workspace.orchestration.active(repo.path)).toBe("orchestrator");
});

test.each([
  { kind: "resume", persisted: false },
  { kind: "new-conversation", persisted: false },
  { kind: "resume", persisted: true },
] as const)(
  "an exited remote dispatcher launch can $kind on its host (persisted: $persisted)",
  async ({ kind, persisted }) => {
    scans.current = {
      ...scans.current,
      agents: scans.current.agents.map((agent) => ({ ...agent, initialPrompt: true })),
    };
    const folder = "/work/code";
    const machine = {
      codeFolder: folder,
      repository: { directory: "repository-fixture", origin: "https://example.test/project.git" },
    };
    type Hosts = NonNullable<WorkspaceDependencies["hosts"]>;
    const repositoryTarget = vi.fn<NonNullable<Hosts["repositoryTarget"]>>(
      async (_host, _repo, validate) => {
        await validate?.();
        return { host: "worker", profile: "fixture", machine };
      },
    );
    const hosts: Hosts = {
      registered: () => ({ host: "worker", codeFolder: folder }),
      requireAgent: () => Promise.resolve(),
      worktree: vi.fn(),
      fleet: () => Promise.resolve([]),
      shellTarget: () => ({ host: "worker" }),
      repositoryTarget,
    };
    const create = vi.fn<WorkspaceDependencies["terminals"]["create"]>(() =>
      Promise.resolve("remote"),
    );
    const { readSessions } = await import("../../../../src/main/workspace/session-store");
    const workspace = createWorkspace({
      ...deps,
      hosts,
      terminals: { ...deps.terminals, create },
      ...(persisted && {
        sessions: {
          load: () =>
            Promise.resolve(
              readSessions([
                {
                  id: "remote",
                  agent: "claude",
                  repository: repo.path,
                  worktree: "/foom-remote/fixture",
                  branch: "Main checkout · worker",
                  conversationId: "saved-conversation",
                  remote: true,
                  placement: { kind: "remote", host: "worker" },
                  running: false,
                },
              ]),
            ),
          save: async () => {},
          flush: async () => {},
        },
      }),
    });
    if (persisted) {
      await workspace.restore();
      expect(workspace.orchestration.view("remote")).toBeUndefined();
    } else {
      launch.mockImplementationOnce(async (request) => {
        await request.prepareSpawn?.();
        request.beforeSpawn?.();
        if (request.control && "role" in request.control) request.control.beforeBind?.("remote");
        return {
          id: "remote",
          attention: "evaluator",
          remote: true,
          placement: { kind: "remote", host: "worker" },
          conversationId: "saved-conversation",
        } as const;
      });
      await workspace.dispatcherHost.launch(
        { ...launchRequest, host: "worker" },
        proof,
        "dispatcher",
        async () => {},
        () => {},
        { ...lifecycle, terminalId: "remote" },
      );
      await workspace.exited("remote", 0);
      expect(workspace.orchestration.view("remote")).toMatchObject({
        role: "orchestrator",
        active: false,
      });
    }
    await workspace.sidebarCommand({ kind, id: "remote" }, confirm);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      id: "remote",
      remote: { host: "worker", machine: { ...machine, agent: "claude" } },
      args: kind === "resume" ? ["--resume", "saved-conversation"] : [],
    });
    expect(repositoryTarget).toHaveBeenLastCalledWith("worker", repo.path);
    expect(launch).toHaveBeenCalledTimes(persisted ? 0 : 1);
    expect(workspace.orchestration.active(repo.path)).toBeUndefined();
  },
);

test("dispatcher revalidates the approved checkout before remote preparation dispatch", async () => {
  let approvedCheckout = true;
  const prepareCheckout = vi.fn();
  const hosts: NonNullable<WorkspaceDependencies["hosts"]> = {
    registered: (host) => ({ host, codeFolder: "/work/code" }),
    requireAgent: () => {
      approvedCheckout = false;
      return Promise.resolve();
    },
    worktree: vi.fn(),
    fleet: vi.fn(),
    repositoryTarget: async (_host, _path, authorize) => {
      await authorize?.();
      prepareCheckout();
      throw new Error("fixture dispatched");
    },
  };
  const workspace = createWorkspace({ ...deps, hosts });
  const verify = () =>
    approvedCheckout ? Promise.resolve() : Promise.reject(new Error("checkout changed"));
  await expect(
    workspace.dispatcherHost.launch(
      { ...launchRequest, host: "worker" },
      proof,
      "dispatcher",
      verify,
      vi.fn(),
      lifecycle,
    ),
  ).rejects.toThrow("checkout changed");
  expect(prepareCheckout).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

test("workspace wires the source session, trusted elevation, and live dispatcher board through control runtime", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foom-dispatcher-runtime-")));
  const source = join(root, "source");
  const project = join(source, "team", "project");
  const registered = { ...repo, path: project };
  await mkdir(project, { recursive: true });
  await git(["init", "-q"], { cwd: project });
  let startRuntime: () => ReturnType<typeof ControlRuntime.start> = () => {
    throw new Error("Workspace not initialized");
  };
  const factory = deps.agents;
  if (!factory) throw new Error("Missing fixture agent factory");
  let prepareControl: Parameters<typeof factory>[1];
  let sourceEnv: Readonly<Record<string, string>> | undefined;
  let projectIdentity = "";
  const workspace = createWorkspace({
    ...deps,
    control: () => startRuntime(),
    worktrees: {
      ...deps.worktrees,
      listRepositories: () => [registered],
      launchIdentity: () => Promise.resolve(projectIdentity),
    },
    agents: (hooks, control) => {
      prepareControl = control;
      return factory(hooks, control);
    },
  });
  const changed = vi.fn();
  let runtime: ReturnType<typeof ControlRuntime.start> | undefined;
  startRuntime = () =>
    (runtime ??= ControlRuntime.start(
      root,
      () => workspace.snapshot().terminals,
      undefined,
      workspace.orchestration,
      undefined,
      changed,
      undefined,
      undefined,
      undefined,
      workspace.dispatcherHost,
    ));
  try {
    await expect(workspace.demoteDispatcher("missing")).rejects.toThrow("unavailable");
    workspace.configure({ hooks: true, agents: ENABLED_AGENTS, codeFolder: source });
    scans.current = {
      ...scans.current,
      agents: scans.current.agents.map((agent) => ({ ...agent, initialPrompt: true })),
    };
    launch.mockImplementationOnce(async (request) => {
      expect(request.worktree).toBe(source);
      const grant = await prepareControl?.(
        request.repository,
        request.worktree,
        request.terminalId,
        request.control,
        request.humanSource,
      );
      if (!grant) throw new Error("Missing source control grant");
      grant.bind("dispatcher");
      sourceEnv = grant.env;
      return { id: "dispatcher", attention: "evaluator" };
    });
    await workspace.sidebarCommand({ kind: "machine-launch", run: "claude", host: null }, confirm);
    await expect(
      workspace.sidebarCommand({ kind: "elevate-dispatcher", id: "dispatcher" }, confirm),
    ).rejects.toThrow("trusted window");
    const select = vi.fn(() => Promise.resolve([project]));
    workspace.configure({ hooks: true, agents: ENABLED_AGENTS, codeFolder: null });
    await expect(workspace.elevateDispatcher("dispatcher", select)).rejects.toThrow("not_found");
    expect(select).not.toHaveBeenCalled();
    workspace.configure({ hooks: true, agents: ENABLED_AGENTS, codeFolder: source });
    await workspace.elevateDispatcher("dispatcher", select);
    expect(select).toHaveBeenCalledWith(source, [
      { name: join("team", "project"), path: project, running: false },
    ]);
    expect(workspace.snapshot().terminals).toEqual([
      expect.objectContaining({ dispatcher: { orchestrators: 0, repositories: 1 } }),
    ]);
    expect(changed).toHaveBeenCalled();
    await expect(workspace.messageBoard("decisions", { watch: [] })).resolves.toMatchObject({
      counts: {},
      orchestrators: { dispatcher: Dispatcher.decisionScope("dispatcher") },
    });
    await expect(
      workspace.messageBoard("answer", {
        answers: [{ post: "missing", index: 0, option: "once" }],
        idempotencyKey: "unrelated",
      }),
    ).rejects.toThrow("not_found");
    projectIdentity = (await workspace.dispatcherHost.repository(source, project)).identity;
    let orchestratorId: string | undefined;
    launch.mockImplementationOnce(async (request) => {
      const id = request.terminalId;
      if (!id) throw new Error("Missing reserved orchestrator ID");
      orchestratorId = id;
      await request.prepareSpawn?.();
      request.beforeSpawn?.();
      const grant = await prepareControl?.(
        request.repository,
        request.worktree,
        undefined,
        request.control,
      );
      if (!grant?.remoteCall) throw new Error("Missing orchestrator relay");
      grant.bind(id);
      expect(workspace.orchestration.active(project)).toBe(id);
      const identity = await grant.remoteCall("whoami", {});
      if (identity.type !== "identity") throw new Error("Missing relay identity");
      expect(identity.capabilities).toContain("handoff");
      const result = await grant.remoteCall("handoff", {
        status: "done",
        summary: "Fixture finished.",
        idempotencyKey: "startup-report",
      });
      if (result.type !== "orchestrator-result") throw new Error("Startup handoff failed");
      expect(result.payload).toContain('"seq":1');
      return { id, attention: "evaluator" };
    });
    const endpoint = sourceEnv?.["FOOM_CONTROL_URL"];
    if (!endpoint) throw new Error("Missing source endpoint");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sourceEnv?.["FOOM_CONTROL_TOKEN"] ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        instanceId: sourceEnv?.["FOOM_CONTROL_INSTANCE"],
        method: "launch_orchestrator",
        params: { ...launchRequest, repo: project },
      }),
    });
    const receipt: unknown = await response.json();
    if (!orchestratorId) throw new Error("Missing launched orchestrator ID");
    expect(receipt).toMatchObject({ result: { status: "succeeded", resultId: orchestratorId } });
    expect(workspace.orchestration.handoffs.latest(orchestratorId)).toMatchObject({ seq: 1 });
    await workspace.demoteDispatcher("dispatcher");
    expect(workspace.snapshot().terminals[0]?.dispatcher).toBeUndefined();
  } finally {
    await workspace.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])("source restart checks recovery (%s)", async (authorized) => {
  const directory = resolve("fixture-source");
  const project = join(directory, "project");
  const dispatcherId = "saved-dispatcher";
  const orchestratorId = "saved-orchestrator";
  const factory = deps.agents;
  if (!factory) throw new Error("Missing fixture agent factory");
  const scan = vi.fn(() => Promise.resolve(scans.current));
  const setDispatcherRole = vi.fn<ControlRuntime["setRole"]>();
  const entries = [
    {
      id: orchestratorId,
      agent: "claude",
      repository: project,
      worktree: project,
      branch: "main",
      conversationId: "orchestration-conversation",
      running: true,
      orchestrator: { identity: "project-proof", history: [] },
    },
    {
      id: dispatcherId,
      agent: "claude",
      repository: directory,
      worktree: directory,
      branch: null,
      conversationId: "dispatcher-conversation",
      running: true,
      home: true as const,
      machine: true as const,
      sourceSession: true as const,
    },
  ];
  const { readSessions } = await import("../../../../src/main/workspace/session-store");
  let startControl: NonNullable<WorkspaceDependencies["control"]> = () => {
    throw new Error("Workspace not initialized");
  };
  const workspace = createWorkspace({
    ...deps,
    agents: (hooks, control) => ({ ...factory(hooks, control), scan }),
    control: () => startControl(),
    worktrees: {
      ...deps.worktrees,
      listRepositories: () => [{ name: "project", path: project }],
      listWorktrees: () =>
        Promise.resolve([
          {
            path: project,
            head: "head",
            branch: "main",
            bare: false,
            locked: false,
            prunable: false,
            managed: false,
          },
        ]),
      launchIdentity: () => Promise.resolve("project-proof"),
    },
    sessions: {
      load: () => Promise.resolve(readSessions(entries)),
      save: () => Promise.resolve(),
      flush: () => Promise.resolve(),
    },
  });
  const dispatcher = new Dispatcher(
    { ...workspace.dispatcherHost, directoryIdentity: () => Promise.resolve("source-proof") },
    () => workspace.snapshot().terminals,
    vi.fn(),
    vi.fn(),
    [
      {
        id: dispatcherId,
        directory,
        identity: "source-proof",
        ...(authorized ? { restoreConversation: "dispatcher-conversation" } : {}),
        approved: [{ path: project, identity: "project-proof" }],
        adopted: [{ id: orchestratorId, path: project, identity: "project-proof", launched: true }],
      },
    ],
  );
  startControl = () =>
    Promise.resolve({
      prepare: vi.fn<ControlRuntime["prepare"]>(),
      close: () => Promise.resolve(),
      dispatcher,
      setRole: setDispatcherRole,
    });
  await workspace.initializeControl();
  launch.mockImplementation(async ({ terminalId, humanSource }) => {
    if (!terminalId) throw new Error("Missing saved terminal ID");
    if (humanSource) {
      expect(workspace.orchestration.active(project)).toBe(orchestratorId);
      scan.mockRejectedValueOnce(new Error("Agent plugins changed. Scan again."));
      await expect(workspace.scanAgents(true)).rejects.toThrow(
        "Agent plugins changed. Scan again.",
      );
    }
    return { id: terminalId, attention: "evaluator" };
  });

  await workspace.restore();
  await workspace.restartSaved();

  expect(launch.mock.calls.map(([request]) => request.terminalId)).toEqual([
    orchestratorId,
    dispatcherId,
  ]);
  expect(scan).toHaveBeenCalledTimes(2);
  const view = workspace.snapshot().terminals.find(({ id }) => id === dispatcherId)?.dispatcher;
  if (authorized) {
    expect(setDispatcherRole).toHaveBeenCalledExactlyOnceWith(dispatcherId, "dispatcher");
    expect(view).toEqual({ orchestrators: 1, repositories: 1 });
  } else {
    expect(setDispatcherRole).not.toHaveBeenCalled();
    expect(view).toBeUndefined();
  }
});

test("dispatcher refuses unavailable placements and providers before spawning", async () => {
  const verify = vi.fn(() => Promise.resolve());
  const active = vi.fn();
  const local = createWorkspace();
  await expect(local.elevateDispatcher("missing", vi.fn())).rejects.toThrow("unavailable");
  await expect(
    local.dispatcherHost.launch(
      launchRequest,
      { ...proof, path: "/fixture/foreign" },
      "dispatcher",
      verify,
      active,
      lifecycle,
    ),
  ).rejects.toThrow("conflict");
  await expect(
    local.dispatcherHost.launch(
      { ...launchRequest, host: "unknown" },
      proof,
      "dispatcher",
      verify,
      active,
      lifecycle,
    ),
  ).rejects.toThrow("host_unavailable");
  await expect(
    local.dispatcherHost.launch(launchRequest, proof, "dispatcher", verify, active, lifecycle),
  ).rejects.toThrow("unsupported");
  const unapproved = createWorkspace({
    ...deps,
    hosts: {
      registered: (host) => ({ host, codeFolder: "/fixture/approved" }),
      requireAgent: vi.fn(() => Promise.resolve()),
      worktree: vi.fn(),
      fleet: vi.fn(() => Promise.resolve([])),
      repositoryTarget: vi.fn(() =>
        Promise.resolve({
          host: "worker",
          profile: "fixture",
          machine: { codeFolder: "/fixture/changed" },
        }),
      ),
    },
  });
  await expect(
    unapproved.dispatcherHost.launch(
      { ...launchRequest, host: "worker" },
      proof,
      "dispatcher",
      verify,
      active,
      lifecycle,
    ),
  ).rejects.toThrow("host_unavailable");
  expect(launch).not.toHaveBeenCalled();
  await expect(
    local.dispatcherHost.prompt("unknown", { kind: "prompt", text: "Check" }),
  ).rejects.toThrow("adapter unavailable");
  stop.mockResolvedValueOnce(false);
  await expect(local.dispatcherHost.stop("unknown")).rejects.toThrow("conflict");
  await expect(local.dispatcherHost.stop("unknown")).resolves.toBeUndefined();
  expect(local.dispatcherHost.handoffs?.("unknown")).toEqual([]);
});
