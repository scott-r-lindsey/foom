import type { Repository } from "../../shared/worktrees";
import type { ForgeProviderFactory } from "../control/forge.d";
import type { WorktreeService } from "./worktrees";

export type AdoptionService = Pick<
  WorktreeService,
  "validateBranch" | "listWorktrees" | "launchIdentity" | "createWorktree"
>;
export type ForgeProviderFor = (
  repository: string,
  path: string,
  remote: string,
) => ReturnType<ForgeProviderFactory>;
export interface FetchFacts {
  branch: string | null;
  time: number;
  failed: boolean;
  head: string | null;
}

export interface CreationContext extends Pick<WorktreeService, "validateBranch" | "listWorktrees"> {
  readonly root: string;
  readonly createdParents: Map<string, string>;
  readonly managed: Map<string, { repository: string; root: string; identity: string }>;
  repository(path: string): Repository;
  save(): Promise<void>;
}

export type ForgeService = Pick<
  WorktreeService,
  "launchIdentity" | "listWorktrees" | "forgeRemote"
>;
