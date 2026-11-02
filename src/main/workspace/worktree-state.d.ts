import type { ReviewCheckout } from "./review-worktrees";
import type { Repository, Worktree } from "../../shared/worktrees";
import type { FetchFacts, ForgeProviderFor } from "./worktree-features.d";

export interface WorktreeStoredState {
  version: 1;
  repositories: string[];
  parents?: { path: string; identity: string }[];
  managed: {
    path: string;
    repository: string;
    root: string;
    identity: string;
    review?: ReviewCheckout;
  }[];
}
export interface InventoryDependencies {
  listWorktrees(repository: string): Promise<readonly Worktree[]>;
}
export interface IdentityDependencies extends InventoryDependencies {
  git(cwd: string, args: string[]): Promise<string>;
  validatePath(path: string): void;
  realpath(path: string): Promise<string>;
}
export interface BranchCleanupDependencies extends InventoryDependencies {
  validateBranch(repository: string, branch: string): Promise<void>;
}
export interface FetchStateDependencies {
  repository(path: string): Repository;
  validateBranch(repository: string, branch: string): Promise<void>;
  invalidatePanels(): void;
  now(): number;
}
export interface PanelFactsDependencies {
  launchIdentity(repository: string, path: string): Promise<string>;
  fetchFacts: (repository: string) => FetchFacts | undefined;
  now(): number;
}
export interface MergePolicyDependencies extends BranchCleanupDependencies {
  checkRemovalIdentity(repository: string, path: string, identity: string): Promise<void>;
  mergedDefault(repository: string, refresh: boolean): Promise<string>;
  changes(repository: string, path: string, identity?: string): Promise<string>;
  forgeRemote(repository: string): Promise<string | undefined>;
  forgeProviderFor: ForgeProviderFor;
  fetchFacts: (repository: string) => FetchFacts | undefined;
}
