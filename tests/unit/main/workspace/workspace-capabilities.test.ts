import { describe, expect, it, vi } from "vitest";
import { addWorktree, createWorktree } from "../../../../src/main/workspace/sidebar-commands";
import type { RepositoryOperationsContext } from "../../../../src/main/workspace/workspace-capabilities";

/** This isolated feature fixture has no coordinator, terminal service or control startup. */
function repositoryFixture(): RepositoryOperationsContext {
  const tree = {
    path: "/trees/feature",
    branch: "feature",
    head: "abc",
    bare: false,
    locked: false,
    prunable: false,
    managed: true,
  };
  const capabilities: RepositoryOperationsContext = {
    launched: new Map(),
    busyWorktrees: new Set(),
    location: "adjacent",
    refresh: vi.fn(),
    withRepository: (_repository, work) => work(),
    cleanup: { removeIdleTree: vi.fn() },
    deps: {
      worktrees: {
        createWorktree: vi.fn().mockResolvedValue({ path: tree.path, outcome: "new" }),
        listWorktrees: vi.fn().mockResolvedValue([tree]),
      },
    },
    addWorktree: (repository, branch, location) =>
      addWorktree.call(capabilities, repository, branch, location),
  };
  return capabilities;
}

describe("isolated workspace capabilities", () => {
  it("creates a checkout with only its declared feature effects", async () => {
    const capabilities = repositoryFixture();
    await expect(createWorktree.call(capabilities, "/repo", "feature")).resolves.toMatchObject({
      path: "/trees/feature",
      outcome: "new",
    });
    expect(capabilities.deps.worktrees.createWorktree).toHaveBeenCalledWith("/repo", "feature", {
      location: "adjacent",
    });
    expect(capabilities.busyWorktrees.size).toBe(0);
    expect(capabilities.refresh).toHaveBeenCalledOnce();
  });

  it("uses the shared reservation before any asynchronous checkout effect", async () => {
    const capabilities = repositoryFixture();
    capabilities.busyWorktrees.add("/repo\0feature");
    await expect(createWorktree.call(capabilities, "/repo", "feature")).rejects.toThrow(
      "This worktree is busy",
    );
    expect(capabilities.deps.worktrees.createWorktree).not.toHaveBeenCalled();
  });

  it("releases its reservation when creation fails", async () => {
    const capabilities = repositoryFixture();
    vi.mocked(capabilities.deps.worktrees.createWorktree).mockRejectedValue(new Error("failed"));
    await expect(createWorktree.call(capabilities, "/repo", "feature")).rejects.toThrow("failed");
    expect(capabilities.busyWorktrees.size).toBe(0);
    expect(capabilities.refresh).not.toHaveBeenCalled();
  });
});
