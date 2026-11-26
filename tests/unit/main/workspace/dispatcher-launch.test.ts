import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("dispatcher launches use the ordinary orchestrator slot and recheck scope before spawn", async () => {
  scans.current = {
    ...scans.current,
    agents: scans.current.agents.map((agent) => ({ ...agent, initialPrompt: true })),
  };
  const workspace = createWorkspace();
  const verify = vi.fn(() => Promise.resolve());
  const active = vi.fn();
  launch.mockImplementationOnce(async (request) => {
    await request.prepareSpawn?.();
    request.beforeSpawn?.();
    return { id: "orchestrator", attention: "evaluator" };
  });
  await expect(
    workspace.dispatcherHost.launch(launchRequest, proof, "dispatcher", verify, active),
  ).resolves.toBe("orchestrator");
  expect(verify).toHaveBeenCalledTimes(3);
  expect(active).toHaveBeenCalledTimes(3);
  expect(launch).toHaveBeenCalledWith(
    expect.objectContaining({
      repository: repo.path,
      worktree: repo.path,
      automated: true,
      localOnly: true,
      control: { role: "orchestrator" },
      prompt: launchRequest.prompt,
    }),
  );
  expect(workspace.orchestration.active(repo.path)).toBe("orchestrator");
  expect(deps.placeChild).toHaveBeenCalledWith("orchestrator", "dispatcher");
  await expect(
    workspace.dispatcherHost.launch(launchRequest, proof, "dispatcher", verify, active),
  ).rejects.toThrow("conflict");
  expect(launch).toHaveBeenCalledOnce();
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
    ),
  ).resolves.toBe("orchestrator");
  expect(mapped).toMatchObject({ path: `${folder}/${clone}`, origin, target: { host: "worker" } });
  expect(hosts.requireAgent).toHaveBeenCalledExactlyOnceWith("worker", "claude");
  expect(hosts.registered).toHaveBeenCalledWith("worker", folder);
  expect(workspace.orchestration.active(repo.path)).toBe("orchestrator");
});

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
    ),
  ).rejects.toThrow("checkout changed");
  expect(prepareCheckout).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

test("workspace wires the source session, trusted elevation, and live dispatcher board through control runtime", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foom-dispatcher-runtime-")));
  const source = join(root, "source");
  const project = join(source, "project");
  await mkdir(project, { recursive: true });
  await git(["init", "-q"], { cwd: project });
  let startRuntime: () => ReturnType<typeof ControlRuntime.start> = () => {
    throw new Error("Workspace not initialized");
  };
  const factory = deps.agents;
  if (!factory) throw new Error("Missing fixture agent factory");
  let prepareControl: Parameters<typeof factory>[1];
  const workspace = createWorkspace({
    ...deps,
    control: () => startRuntime(),
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
    workspace.configure({ hooks: true, agents: ENABLED_AGENTS, sourceDirectory: source });
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
      return { id: "dispatcher", attention: "evaluator" };
    });
    await workspace.sidebarCommand({ kind: "machine-launch", run: "claude", host: null }, confirm);
    await expect(
      workspace.sidebarCommand({ kind: "elevate-dispatcher", id: "dispatcher" }, confirm),
    ).rejects.toThrow("trusted window");
    const select = vi.fn(() => Promise.resolve(["project"]));
    await workspace.elevateDispatcher("dispatcher", select);
    expect(select).toHaveBeenCalledWith(source, [{ name: "project", running: false }]);
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
    await workspace.demoteDispatcher("dispatcher");
    expect(workspace.snapshot().terminals[0]?.dispatcher).toBeUndefined();
  } finally {
    await workspace.dispose();
    await rm(root, { recursive: true, force: true });
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
    ),
  ).rejects.toThrow("conflict");
  await expect(
    local.dispatcherHost.launch(
      { ...launchRequest, host: "unknown" },
      proof,
      "dispatcher",
      verify,
      active,
    ),
  ).rejects.toThrow("host_unavailable");
  await expect(
    local.dispatcherHost.launch(launchRequest, proof, "dispatcher", verify, active),
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
