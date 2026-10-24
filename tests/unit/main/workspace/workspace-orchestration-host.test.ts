import { describe, expect, it, vi } from "vitest";
import type { Principal } from "../../../../src/main/control/types";
import type { Handoff } from "../../../../src/shared/handoff";
import type { OrchestrationHostContext } from "../../../../src/main/workspace/workspace-capabilities";
import { workspaceOrchestrationHost } from "../../../../src/main/workspace/workspace-orchestration-host";

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
      forge: undefined,
      worktrees: {
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
