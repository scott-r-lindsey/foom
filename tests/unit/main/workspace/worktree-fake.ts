import { vi } from "vitest";
import type { WorkspaceDependencies } from "../../../../src/main/workspace/workspace-types";
import type { Repository, Worktree } from "../../../../src/shared/worktrees";

/** Plain mock builder: no hooks, evaluator state or shared mutable fixtures. */
export function worktreeFake(
  repo: Repository,
  tree: Worktree,
  overrides: Partial<WorkspaceDependencies["worktrees"]> = {},
): WorkspaceDependencies["worktrees"] {
  return {
    reviewBranch: vi.fn(() => undefined),
    reviewIdentity: vi.fn(() => undefined),
    canAutoRemoveReview: vi.fn(() => Promise.resolve(false)),
    canAutoRemove: vi.fn(() => Promise.resolve(false)),
    panelFacts: vi.fn(),
    listRepositories: vi.fn(() => [repo]),
    addRepository: vi.fn(() => Promise.resolve(repo)),
    listWorktrees: vi.fn(() => Promise.resolve([tree])),
    validateBranch: vi.fn(async () => {}),
    launchIdentity: vi.fn(() => Promise.resolve("identity")),
    removalIdentity: vi.fn(() => Promise.resolve("identity")),
    changes: vi.fn(() => Promise.resolve("")),
    cleanupBrokenWorktree: vi.fn(async () => {}),
    cleanupStatus: vi.fn(() => Promise.resolve("")),
    cleanupChanges: vi.fn(() => Promise.resolve("")),
    mergedFetchTime: vi.fn(() => 1000),
    mergedDefault: vi.fn(() => Promise.resolve("base")),
    mergedCommit: vi.fn(() => Promise.resolve(false)),
    deleteMergedBranches: vi.fn(() => Promise.resolve([])),
    deleteMergedBranch: vi.fn(async () => {}),
    removeRepository: vi.fn(async () => {}),
    pruneWorktree: vi.fn(async () => {}),
    removeWorktree: vi.fn(async () => {}),
    adoptWorktree: vi.fn(),
    createWorktree: vi.fn(() => Promise.resolve({ path: tree.path, outcome: "new" as const })),
    branches: vi.fn(),
    ...overrides,
  };
}
