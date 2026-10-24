import { describe, expect, it, vi } from "vitest";
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
