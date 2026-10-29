import type { Hosts } from "../../../../src/main/setup/hosts";
import { localResources } from "../../../../src/main/setup/local-host";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../../../../src/main/control/types";
import type { Handoff } from "../../../../src/shared/handoff";
import type { OrchestrationHostContext } from "../../../../src/main/workspace/workspace-capabilities";
import { workspaceOrchestrationHost } from "../../../../src/main/workspace/workspace-orchestration-host";
import { UncertainEffect } from "../../../../src/main/workspace/worktree-outcome";
import { ControlError } from "../../../../src/shared/control-validation";
import { harness } from "../control/orchestration-helpers";

vi.mock("../../../../src/main/setup/local-host", () => ({
  localResources: vi.fn(() =>
    Promise.resolve({ cores: 4, load: [0, 0, 0], memoryTotal: 8000, memoryAvailable: 4000 }),
  ),
}));

/** Only host capabilities: no agent launcher, cleanup service or coordinator construction. */
function hostFixture() {
  const capabilities: OrchestrationHostContext = {
    busyWorktrees: new Set(),
    cleanup: { removeOwnedTree: vi.fn() },
    closed: false,
    control: undefined,
    createChildWorktree: vi.fn(),
    defaultArguments: { claude: [], codex: [], agy: [] },
    input: vi.fn(),
    launchChild: vi.fn(),
    launchAgent: vi.fn(),
    location: "adjacent",
    persist: vi.fn(),
    refresh: vi.fn(),
    scanAgents: vi.fn(),
    sessions: { isRestoring: vi.fn(), save: vi.fn() },
    showNewChildren: true,
    sidebarCommand: vi.fn(),
    snapshot: () => ({ repositories: [], terminals: [] }),
    withRepository: (_repository, work) => work(),
    deps: {
      hosts: undefined,
      forge: undefined,
      worktrees: {
        reviewBranch: vi.fn(),
        adoptionBranch: vi.fn(),
        adoptWorktree: vi.fn(),
        listWorktrees: vi.fn(),
        launchIdentity: vi.fn(),
      },
      terminals: { stop: vi.fn(), tail: vi.fn(), childInput: undefined },
      placeChild: undefined,
      reveal: undefined,
      dialog: undefined,
    },
  };
  return capabilities;
}

describe("isolated orchestration host capabilities", () => {
  it("holds PR and branch reservations through adoption and caller revalidation", async () => {
    const capabilities = hostFixture();
    const host = workspaceOrchestrationHost(capabilities);
    const revalidate = vi.fn(() => {
      expect(capabilities.busyWorktrees.has("/repo\0:adopt-pr-337")).toBe(true);
      expect(capabilities.busyWorktrees.has("/repo\0feature")).toBe(true);
    });
    const result = { path: "/trees/feature", branch: "feature", identity: "identity" };
    vi.mocked(capabilities.deps.worktrees.adoptWorktree).mockImplementation(
      async (_repository, _number, _unused, validate, location) => {
        expect(location).toBe("adjacent");
        validate(result.path, result.branch);
        await Promise.resolve();
        expect(capabilities.busyWorktrees.size).toBe(2);
        return result;
      },
    );
    await expect(host.adoptWorktree?.("/repo", 337, [], revalidate)).resolves.toEqual(result);
    expect(revalidate).toHaveBeenCalledWith(result.path, result.branch);
    expect(capabilities.busyWorktrees.size).toBe(0);
    expect(capabilities.refresh).toHaveBeenCalledOnce();
  });

  it("does not release another operation's branch reservation on refusal", async () => {
    const capabilities = hostFixture();
    capabilities.busyWorktrees.add("/repo\0feature");
    const revalidate = vi.fn();
    vi.mocked(capabilities.deps.worktrees.adoptWorktree).mockImplementation(
      (_repository, _number, _unused, validate) => {
        validate("/trees/feature", "feature");
        return Promise.reject(new Error("unreachable"));
      },
    );
    await expect(
      workspaceOrchestrationHost(capabilities).adoptWorktree?.("/repo", 337, [], revalidate),
    ).rejects.toThrow("branch_in_use");
    expect(revalidate).not.toHaveBeenCalled();
    expect([...capabilities.busyWorktrees]).toEqual(["/repo\0feature"]);
    expect(capabilities.refresh).toHaveBeenCalledOnce();
  });
});

const actor: Principal = {
  grantedAt: new Date(0).toISOString(),
  generation: "generation",
  sessionId: "session",
  repository: "/repo",
  worktree: "/trees/feature",
  terminalId: "child",
  parentId: "parent",
  role: "agent",
};
const report: Handoff = {
  seq: 1,
  status: "done",
  summary: "Completed",
  links: [],
  timestamp: new Date(0).toISOString(),
};

it("refuses handoff auditing without an available audit capability", async () => {
  const caps = hostFixture();
  await expect(
    workspaceOrchestrationHost(caps).auditHandoff?.(actor, report),
  ).rejects.toMatchObject({
    code: "unavailable",
  });
  await expect(
    workspaceOrchestrationHost({ ...caps, control: Promise.resolve({}) }).auditHandoff?.(
      actor,
      report,
    ),
  ).rejects.toMatchObject({ code: "unavailable" });
});

it("awaits durable handoff auditing before reporting success and propagates audit failures", async () => {
  const pending = Promise.withResolvers<undefined>();
  const handoff = vi.fn(() => pending.promise);
  const host = workspaceOrchestrationHost({
    ...hostFixture(),
    control: Promise.resolve({ audit: { handoff } }),
  });
  const result = host.auditHandoff?.(actor, report);
  let settled = false;
  void result?.then(() => {
    settled = true;
  });
  await vi.waitFor(() => {
    expect(handoff).toHaveBeenCalledWith(actor, report);
  });
  expect(settled).toBe(false);
  pending.resolve(undefined);
  await result;
  expect(settled).toBe(true);
  handoff.mockRejectedValueOnce(new Error("audit unavailable"));
  await expect(host.auditHandoff?.(actor, report)).rejects.toThrow("audit unavailable");
});

it("reveals only the requested session through the optional navigation capability", () => {
  const caps = hostFixture();
  const reveal = vi.fn();
  workspaceOrchestrationHost({ ...caps, deps: { ...caps.deps, reveal } }).reveal?.("child");
  expect(reveal).toHaveBeenCalledExactlyOnceWith("child");
  expect(() => workspaceOrchestrationHost(caps).reveal?.("child")).not.toThrow();
});

it("does not persist or refresh host changes after shutdown", () => {
  const caps = hostFixture();
  workspaceOrchestrationHost(caps).changed();
  expect(caps.persist).toHaveBeenCalledOnce();
  expect(caps.refresh).toHaveBeenCalledOnce();
  vi.mocked(caps.persist).mockClear();
  vi.mocked(caps.refresh).mockClear();
  workspaceOrchestrationHost({ ...caps, closed: true }).changed();
  expect(caps.persist).not.toHaveBeenCalled();
  expect(caps.refresh).not.toHaveBeenCalled();
});

it("restores only recorded detached review heads and retains the source PR branch", async () => {
  const caps = hostFixture();
  vi.mocked(caps.deps.worktrees.listWorktrees).mockResolvedValue([
    {
      path: "/review",
      branch: null,
      head: "head",
      managed: true,
      bare: false,
      locked: false,
      prunable: false,
    },
  ]);
  vi.mocked(caps.deps.worktrees.launchIdentity).mockResolvedValue("identity");
  const host = workspaceOrchestrationHost(caps);
  expect(await host.restoreWorktree("/repo", "/review")).toBeUndefined();
  vi.mocked(caps.deps.worktrees.reviewBranch).mockReturnValue("feature");
  expect(await host.restoreWorktree("/repo", "/review")).toEqual({
    branch: "feature",
    identity: "identity",
  });
  expect(caps.deps.worktrees.reviewBranch).toHaveBeenCalledWith("/repo", "/review", "head");
});

function fleetFixture() {
  const base = hostFixture();
  const tree = {
    repository: "/code/repository-fixture",
    path: "/code/.foom-worktree-fixture",
    branch: "feature",
    identity: "a".repeat(64),
    changes: "",
  };
  const hosts = {
    registered: vi.fn(() => ({ host: "worker", codeFolder: "/code" })),
    requireAgent: vi.fn(() => Promise.resolve()),
    worktree: vi.fn(() => Promise.resolve(tree)),
    fleet: vi.fn<Hosts["fleet"]>().mockResolvedValue([]),
  };
  const caps = { ...base, deps: { ...base.deps, hosts } };
  vi.mocked(caps.launchAgent).mockResolvedValue({ id: "child", attention: "evaluator" });
  vi.mocked(caps.scanAgents).mockResolvedValue({ warning: null, agents: [] });
  return { caps, hosts, tree, host: workspaceOrchestrationHost(caps) };
}

it("creates a host-bound opaque checkout and probes inventory before preparing any launch", async () => {
  const { caps, host, hosts, tree } = fleetFixture();
  const created = await host.createWorktree("/local/repo", "feature", "worker");
  expect(created.path).toMatch(/^\/foom-remote\/[a-f0-9]{64}$/u);
  expect(host.worktreeHost?.(created.path)).toBe("worker");
  expect(host.worktreeHost?.("/local/tree")).toBeUndefined();
  expect(hosts.worktree).toHaveBeenCalledWith("worker", "/local/repo", {
    operation: "create-worktree",
    branch: "feature",
  });
  hosts.requireAgent.mockRejectedValueOnce(new Error("missing"));
  await expect(
    host.launch("parent", "/local/repo", created.path, created.identity, "codex", "Task"),
  ).rejects.toThrow("missing");
  expect(caps.launchAgent).not.toHaveBeenCalled();
  expect(hosts.worktree).toHaveBeenCalledTimes(1);
  const validate = vi.fn();
  expect(
    await host.launch("parent", "/local/repo", created.path, created.identity, "codex", "Task", {
      selection: { model: "test" },
      validate,
    }),
  ).toBe("child");
  const launch = vi.mocked(caps.launchAgent).mock.calls.at(-1)?.[5];
  expect(launch).toMatchObject({
    control: { parentId: "parent" },
    selection: { model: "test" },
    prompt: "Task",
    remoteCheckout: {
      target: { host: "worker" },
      repository: tree.repository,
      worktree: tree.path,
      identity: tree.identity,
    },
  });
  launch?.beforeSpawn?.();
  await launch?.remoteCheckout?.validate();
  expect(validate).toHaveBeenCalled();
  await expect(
    host.launch("parent", "/local/repo", created.path, "wrong", "codex", undefined),
  ).rejects.toThrow();
  hosts.worktree.mockResolvedValueOnce({ ...tree, identity: "changed" });
  await expect(
    host.launch("parent", "/local/repo", created.path, created.identity, "codex", undefined),
  ).rejects.toThrow();
  expect(await host.remoteCheckout?.(created.path, "codex")).toMatchObject({
    identity: tree.identity,
  });
  expect(await host.remoteCheckout?.("/unknown", "codex")).toBeUndefined();
  await expect(host.reviewAvailable?.("claude", created.path)).rejects.toMatchObject({
    code: "remote_review_unsupported",
  });
});

it("remote removal retains confirmation, rechecks authorization and refuses while preparation is in flight", async () => {
  const { caps, host, hosts, tree } = fleetFixture();
  const created = await host.createWorktree("/local/repo", "feature", "worker");
  const pending = Promise.withResolvers<undefined>();
  hosts.requireAgent.mockReturnValueOnce(pending.promise);
  const launching = host.launch(
    "parent",
    "/local/repo",
    created.path,
    created.identity,
    "claude",
    undefined,
  );
  const confirm = vi.fn(() => Promise.resolve(true));
  await expect(
    host.remove("/local/repo", created.path, created.identity, confirm, () => {}),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(confirm).not.toHaveBeenCalled();
  pending.resolve(undefined);
  await launching;
  confirm.mockResolvedValueOnce(false);
  expect(await host.remove("/local/repo", created.path, created.identity, confirm, () => {})).toBe(
    false,
  );
  expect(hosts.worktree).not.toHaveBeenCalledWith(
    "worker",
    "/local/repo",
    expect.objectContaining({ operation: "remove-worktree" }),
  );
  const revalidate = vi.fn();
  expect(
    await host.remove("/local/repo", created.path, created.identity, confirm, revalidate),
  ).toBe(true);
  expect(confirm).toHaveBeenLastCalledWith("feature · worker", "");
  expect(revalidate).toHaveBeenCalledTimes(2);
  expect(hosts.worktree).toHaveBeenCalledWith("worker", "/local/repo", {
    operation: "remove-worktree",
    path: tree.path,
    identity: tree.identity,
    changes: "",
  });
  expect(host.worktreeHost?.(created.path)).toBeUndefined();
  expect(caps.busyWorktrees.size).toBe(0);
});

it("uncertain remote removal retains the checkout record for reconciliation", async () => {
  const { host, hosts, tree } = fleetFixture();
  const created = await host.createWorktree("/local/repo", "feature", "worker");
  hosts.worktree.mockResolvedValueOnce(tree).mockRejectedValueOnce(new Error("Connection lost"));
  await expect(
    host.remove(
      "/local/repo",
      created.path,
      created.identity,
      () => Promise.resolve(true),
      () => {},
    ),
  ).rejects.toBeInstanceOf(UncertainEffect);
  expect(host.worktreeHost?.(created.path)).toBe("worker");
});

it("unknown hosts and uncertain creation never fall back to a local checkout", async () => {
  const { caps, hosts, host } = fleetFixture();
  hosts.registered.mockImplementationOnce(() => {
    throw new Error("Unregistered");
  });
  await expect(host.createWorktree("/local/repo", "feature", "unknown")).rejects.toThrow(
    "Unregistered",
  );
  expect(hosts.worktree).not.toHaveBeenCalled();
  expect(caps.createChildWorktree).not.toHaveBeenCalled();
  const uncertain = new UncertainEffect();
  hosts.worktree.mockRejectedValueOnce(uncertain);
  await expect(host.createWorktree("/local/repo", "feature", "worker")).rejects.toBe(uncertain);
});

it("orchestrator host observations contain agent availability and resource numbers, without remote paths or raw output", async () => {
  const { caps, host, hosts } = fleetFixture();
  vi.mocked(caps.scanAgents).mockResolvedValue({
    warning: null,
    agents: [
      { id: "claude", path: "/local/claude", version: "1", hooks: false, reason: "Installed" },
      { id: "codex", path: null, version: null, hooks: false, reason: "Not found" },
      { id: "agy", path: "/local/agy", version: null, hooks: false, reason: "Unavailable" },
    ],
  });
  hosts.fleet.mockResolvedValue([
    {
      host: "worker",
      result: {
        ok: true,
        facts: {
          codeFolder: "/private/remote",
          version: "0.1.0",
          sessions: 2,
          cores: 8,
          load: [1, 2, 3],
          memoryTotal: 8000,
          memoryAvailable: 3000,
          agents: [{ id: "codex", state: "missing" }],
        },
      },
    },
    { host: "offline", result: { ok: false, reason: "unreachable" } },
  ]);
  const observations = await host.hosts?.();
  expect(observations).toMatchObject([
    { host: null, agents: [{ state: "ready" }, { state: "missing" }, { state: "unable" }] },
    { host: "worker", resources: { cores: 8 }, agents: [{ id: "codex", state: "missing" }] },
    { host: "offline", resources: null, reason: "unreachable" },
  ]);
  expect(JSON.stringify(observations)).not.toContain("/private");
  expect(JSON.stringify(observations)).not.toContain("/local/");
  vi.mocked(localResources).mockRejectedValueOnce(new Error("Resource observation unavailable"));
  expect(await host.hosts?.()).toEqual(
    expect.arrayContaining([expect.objectContaining({ host: null, resources: null })]),
  );
  const bare = hostFixture();
  vi.mocked(bare.scanAgents).mockResolvedValue({ warning: null, agents: [] });
  expect(await workspaceOrchestrationHost(bare).hosts?.()).toHaveLength(1);
  await expect(
    workspaceOrchestrationHost(bare).createWorktree("/repo", "branch", "unknown"),
  ).rejects.toMatchObject({ code: "not_found" });
});

it("remote PR branch creation keeps forge validation and refuses unsupported remote review before mutation", async () => {
  const { caps, hosts, host, tree } = fleetFixture();
  vi.mocked(caps.deps.worktrees.adoptionBranch).mockResolvedValue("pr-branch");
  hosts.worktree.mockResolvedValueOnce({ ...tree, branch: "pr-branch" });
  const validate = vi.fn();
  expect(
    await host.adoptWorktree?.("/local/repo", 756, [], validate, false, "worker"),
  ).toMatchObject({ branch: "pr-branch" });
  expect(hosts.worktree).toHaveBeenCalledWith("worker", "/local/repo", {
    operation: "create-worktree",
    branch: "pr-branch",
    fromOrigin: true,
  });
  expect(validate).toHaveBeenCalledTimes(2);
  hosts.worktree.mockClear();
  await expect(
    host.adoptWorktree?.("/local/repo", 756, [], validate, true, "worker"),
  ).rejects.toMatchObject({ code: "remote_review_unsupported" });
  expect(hosts.worktree).not.toHaveBeenCalled();
});

it("charges a remote PR checkout when concurrent adoption makes post-creation validation refuse", async () => {
  const { caps, hosts, host, tree } = fleetFixture();
  const h = harness();
  const adopt = host.adoptWorktree?.bind(host);
  if (!adopt) throw new Error("Missing adoption capability");
  h.host.adoptWorktree.mockImplementation((repository, number, unused, revalidate) =>
    adopt(repository, number, unused, revalidate, false, "worker"),
  );
  for (const branch of ["one", "two", "three"]) await h.mutate("create_worktree", { branch });
  const created = Promise.withResolvers<typeof tree>();
  const resolvingBranch = Promise.withResolvers<string>();
  vi.mocked(caps.deps.worktrees.adoptionBranch)
    .mockResolvedValueOnce("pr1")
    .mockReturnValueOnce(resolvingBranch.promise);
  hosts.worktree
    .mockReturnValueOnce(created.promise)
    .mockResolvedValueOnce({ ...tree, path: "/code/.foom-worktree-second", branch: "pr2" });
  const first = h.mutate("create_worktree", { host: "worker", pullRequest: 1 });
  const firstOutcome = first.catch((error: unknown) => error);
  await vi.waitFor(() => {
    expect(hosts.worktree).toHaveBeenCalledOnce();
  });
  const second = h.mutate("create_worktree", { host: "worker", pullRequest: 2 });
  const secondOutcome = second.catch((error: unknown) => error);
  await vi.waitFor(() => {
    expect(caps.deps.worktrees.adoptionBranch).toHaveBeenCalledTimes(2);
  });
  created.resolve({ ...tree, branch: "pr1" });
  const result = await firstOutcome;
  resolvingBranch.resolve("pr2");
  const refused = await secondOutcome;
  expect(result).toMatchObject({ status: "indeterminate", reason: "uncertain" });
  expect(refused).toMatchObject({ code: "capacity" });
  expect(h.orchestration.ownedWorktrees("parent")).toHaveLength(3);
  expect(h.orchestration.uncertainWorktrees("parent")).toBe(1);
  expect(hosts.worktree).toHaveBeenCalledOnce();
  await expect(h.mutate("create_worktree", { branch: "fifth" })).rejects.toThrow("capacity");
});

it("retains uncertainty when registration disappears after remote creation", async () => {
  const { caps, hosts, host } = fleetFixture();
  hosts.registered
    .mockReturnValueOnce({ host: "worker", codeFolder: "/code" })
    .mockImplementationOnce(() => {
      throw new ControlError("not_found");
    });
  await expect(host.createWorktree("/local/repo", "feature", "worker")).rejects.toBeInstanceOf(
    UncertainEffect,
  );
  expect(hosts.worktree).toHaveBeenCalledOnce();
  expect(caps.createChildWorktree).not.toHaveBeenCalled();
});

it("branch changes retain checkout authority and use the current branch in launch and removal", async () => {
  const { caps, hosts, host, tree } = fleetFixture();
  const created = await host.createWorktree("/local/repo", "feature", "worker");
  hosts.worktree.mockResolvedValue({ ...tree, branch: "changed" });
  await host.launch("parent", "/local/repo", created.path, created.identity, "codex", undefined);
  expect(vi.mocked(caps.launchAgent).mock.calls.at(-1)?.[5]?.remoteCheckout?.branch).toBe(
    "changed",
  );
  const capability = await host.remoteCheckout?.(created.path, "codex");
  expect(capability?.branch).toBe("changed");
  await capability?.validate();
  hosts.worktree.mockResolvedValue({ ...tree, branch: "HEAD" });
  const confirm = vi.fn(() => Promise.resolve(false));
  expect(await host.remove("/local/repo", created.path, created.identity, confirm, () => {})).toBe(
    false,
  );
  expect(confirm).toHaveBeenCalledWith("Detached HEAD · worker", "");
});
