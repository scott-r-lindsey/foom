import type { OwnedWorktree } from "../workspace/session-restore.d";
import type { ForgeWorktree } from "./forge.d";
import type { ReviewSnapshot } from "./review-loops.d";
import type { ForgeTracking } from "./forge-tracking";
import type { AgentId, AgentLaunch } from "../../shared/agents";
import type { DialogContent } from "../../shared/confirmation";
import type { OrchestrationEntry, WorkspaceTerminal } from "../../shared/workspace";
import type { ChildInput } from "../../shared/child-input";
import type { Handoff } from "../../shared/handoff";
import type { Principal } from "./types";

/** Main-owned effects. Every path is chosen by main; the API only names IDs. */
export interface OrchestrationHost {
  hosts?(): Promise<unknown>;
  remoteCheckout?(path: string, agent: AgentId): Promise<AgentLaunch["remoteCheckout"]>;
  worktreeHost?(path: string): string | undefined;
  worktreeLabel?(path: string): string;
  forge?: Pick<ForgeTracking, "track" | "read"> &
    Partial<Pick<ForgeTracking, "readSettled" | "revision" | "waitForRead" | "bindPullRequest">>;
  adoptWorktree?(
    repository: string,
    number: number,
    unused: readonly { path: string; identity: string }[],
    revalidate: (path?: string, branch?: string) => void,
    review?: boolean,
    host?: string,
  ): Promise<Omit<ForgeWorktree, "repository">>;
  terminals(): readonly WorkspaceTerminal[];
  /**
   * A new local branch in a new worktree. PR adoption uses the separate narrow path.
   * Returns the checkout identity captured at creation; throws UncertainEffect when
   * the checkout may exist despite an error.
   */
  createWorktree(
    repository: string,
    branch: string,
    host?: string,
  ): Promise<Omit<ForgeWorktree, "repository">>;
  /** An ordinary child in the checkout created with `identity`: the user's non-bypass defaults, a read-only grant. */
  launch(
    parentId: string,
    repository: string,
    worktree: string,
    identity: string,
    agent: AgentId,
    prompt: string | undefined,
    step?: {
      selection?: AgentLaunch["selection"];
      resume?: { id: string; conversationId: string };
      loop?: AgentLaunch["loop"];
      snapshot?: ReviewSnapshot;
      validateSnapshot?: () => Promise<void>;
      validate(): void;
    },
  ): Promise<string>;
  reviewSnapshot?(repository: string, worktree: string, identity: string): Promise<ReviewSnapshot>;
  reviewAvailable?(agent: AgentId, worktree?: string): Promise<boolean>;
  /** Only an existing Foom-managed linked checkout in this repository is eligible. */
  restoreWorktree(
    repository: string,
    path: string,
  ): Promise<{ branch: string; identity: string } | undefined>;
  /** Whether the user's default arguments for this agent bypass permissions. */
  bypassDefaults?(agent: AgentId): boolean;
  stop(id: string): Promise<boolean>;
  close(id: string, validate?: () => void, signal?: AbortSignal): Promise<boolean>;
  place?(id: string, parentId: string): void;
  /** Starting restored sessions do not yet have a stoppable PTY. */
  starting?(id: string): boolean;
  tail(id: string, lines: number): Promise<string[]>;
  /** The workspace removal sequence: identity and changes are rechecked after `confirm`. */
  remove(
    repository: string,
    worktree: string,
    identity: string,
    confirm: (branch: string, changes: string, automatic?: boolean) => Promise<boolean>,
    revalidate: () => void,
  ): Promise<boolean>;
  /** The trusted app dialog; false when declined, closed or aborted. */
  dialog(content: DialogContent, signal: AbortSignal): Promise<boolean>;
  reply?(id: string, data: ChildInput): Promise<void>;
  reveal?(id: string): void;
  changed(): void;
  saveHandoffs?(): Promise<void>;
  auditHandoff?(actor: Principal, report: Handoff): Promise<void>;
}

export interface Child {
  readonly worktreeId: string;
  exited: boolean;
  takenOver: boolean;
  tailAt: number;
  readHandoff?: number;
}
export interface Parent {
  readonly repository: string;
  terminalId: string | null;
  generation: string | null;
  active: boolean;
  starting: number;
  creating: number;
  /** Creations that may have left a checkout; they stay charged to the unused budget. */
  uncertain: number;
  readonly refusedWorktrees: Set<string>;
  readonly children: Map<string, Child>;
  readonly worktrees: Map<
    string,
    Omit<OwnedWorktree, "state"> & {
      branch: string;
      state: "unused" | "starting" | "continuing" | "used";
    }
  >;
  readonly history: OrchestrationEntry[];
  readonly aborts: Set<AbortController>;
}
