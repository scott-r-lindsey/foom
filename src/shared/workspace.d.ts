import type { CleanupProgress } from "./cleanup";
import type { GitPanelFacts, HomeShellFacts } from "./panel";
import type { AgyPluginAction } from "./agy-plugin";
import type { ExecutionSnapshot, ExecutionTransition } from "./execution";
import type { ConfirmationClient } from "./confirmation";
import type { AgentId, AgentInstallation } from "./agents";
import type { VerdictAction, VerdictState } from "./evaluator";
import type { BranchInventory, CreateOutcome, Repository, Worktree } from "./worktrees";

/**
 * Main's latest view of a terminal's attention state. `verdictId` is null for user
 * actions and for verdicts that couldn't be stored.
 */
export interface TerminalState {
  execution?: ExecutionSnapshot | undefined;
  id: string;
  verdictId: string | null;
  state: VerdictState;
  reason: string;
  signal: string;
  confidence: number;
  timestamp: number;
}

/** A terminal Foom launched in a managed worktree. Paths identify; the renderer never picks them. */
export type McpConnection = "connecting" | "connected" | "not-connected";

export interface WorkspaceTerminal {
  /** Main-observed attachment for this live launch; never persisted. */
  mcpConnection?: McpConnection | undefined;
  execution?: ExecutionSnapshot | undefined;
  id: string;
  kind: "agent" | "shell";
  agent: AgentId | "shell";
  repository: string;
  worktree: string;
  branch: string | null;
  attention: "hooks" | "evaluator";
  state: TerminalState | null;
  exited?: boolean;
  conversationId?: string;
  /** No host screen exists for a restored or failed-to-relaunch session. */
  dormant?: boolean;
  /** Changes when an exited terminal is relaunched under the same ID. */
  launchVersion?: number;
  /** Known bypass argument present at launch; does not infer global agent policy. */
  bypass?: boolean;
  home?: boolean;
  /** Runs in the Foom config folder; `repository` and `worktree` are that folder. */
  config?: boolean;
  startedAt?: number;
  exitCode?: number | undefined;
  launchFlags?: readonly string[];
  /** Names of the variables Foom set from Environment settings; never values. */
  environment?: readonly string[];
  /** Main-computed orchestration role and visible action history; never persisted. */
  orchestration?: OrchestrationView;
  roleNotRestored?: boolean;
}

/** One orchestrator action. Labels are redacted, bounded metadata, never prompts or output. */
export interface OrchestrationEntry {
  id: string;
  action: "create_worktree" | "launch" | "stop" | "remove_worktree" | "take_over";
  label: string;
  status:
    | "pending_confirmation"
    | "running"
    | "succeeded"
    | "failed"
    | "declined"
    | "cancelled"
    | "indeterminate";
  at: number;
}

export type OrchestrationView =
  | {
      role: "orchestrator";
      active: boolean;
      children: number;
      history: readonly OrchestrationEntry[];
    }
  | { role: "child"; parentId: string; takenOver: boolean };

export interface WorkspaceSnapshot {
  repositories: readonly Repository[];
  terminals: readonly WorkspaceTerminal[];
}

/** Scan results without the resolved PATH, which the renderer doesn't need. */
export interface AgentReport {
  warning: string | null;
  agents: readonly AgentInstallation[];
}

export interface LaunchRequest {
  agent: AgentId;
  repository: string;
  worktree: string;
  cols: number;
  rows: number;
  acknowledgeCodexNotifierReplacement?: boolean;
}

export interface StartWorktreeRequest {
  repository: string;
  branch: string;
  run: AgentId | "shell";
  acknowledgeCodexNotifierReplacement: boolean;
}

export interface WorkspaceApi {
  confirmations: ConfirmationClient;
  panelFacts(repository: string, worktree: string): Promise<GitPanelFacts>;
  sidebarInventory(): Promise<SidebarInventory>;
  sidebarCommand(command: SidebarCommand): Promise<void>;
  /** Null means the user cancelled the shared-agent confirmation. */
  startWorktree(request: StartWorktreeRequest): Promise<string | null>;
  /** Main confirms removal, including any uncommitted changes. */
  removeWorktree(id: string): Promise<boolean>;
  workspace(): Promise<WorkspaceSnapshot>;
  onWorkspaceChange(callback: () => void): () => void;
  /** Main shows the directory picker; resolves null when the user cancels. */
  addRepository(): Promise<Repository | null>;
  worktrees(repository: string): Promise<readonly Worktree[]>;
  /** Local refs for the branch field; never fetches. */
  branches(repository: string): Promise<BranchInventory>;
  /** Create only; nothing launches. Without a location, main uses the configured one. */
  createWorktree(
    repository: string,
    branch: string,
    location?: "root" | "adjacent",
  ): Promise<Worktree & { outcome: CreateOutcome }>;
  scanAgents(refresh: boolean): Promise<AgentReport>;
  changeAgyPlugin(action: AgyPluginAction): Promise<AgentReport>;
  /** Null means the user cancelled the shared-agent confirmation. */
  launchAgent(
    request: LaunchRequest,
  ): Promise<{ id: string; attention: "hooks" | "evaluator" } | null>;
  /** Pass null only for the current verdict when it couldn't be stored. */
  feedback(id: string, verdictId: string | null, action: VerdictAction): Promise<void>;
  onExecution(callback: (event: ExecutionTransition) => void): () => void;
  onState(callback: (state: TerminalState) => void): () => void;
}

export interface SidebarInventory {
  repositories: readonly (Repository & {
    worktrees: readonly Worktree[];
    cleanup?: CleanupProgress | undefined;
    canDeleteMerged?: boolean;
    mergedCount?: number;
    mergedError?: string;
  })[];
  shell: string;
  home?: HomeShellFacts;
}
export type SidebarCommand =
  | { kind: "home-shell" }
  | { kind: "copy-home-path" }
  | { kind: "config-launch"; run: AgentId | "shell"; origin?: "menu" }
  | { kind: "copy-config-path" }
  | { kind: "copy-worktree-path"; repository: string; worktree: string }
  | { kind: "launch"; repository: string; worktree: string; run: AgentId | "shell" }
  | { kind: "remove-worktree"; repository: string; worktree: string }
  | { kind: "delete-merged-worktrees"; repository: string }
  | { kind: "remove-repository"; repository: string }
  | { kind: "stop"; id: string }
  | { kind: "close"; id: string }
  | { kind: "restart"; id: string }
  | { kind: "resume"; id: string }
  | {
      kind: "resume-id";
      checkout: { repository: string; worktree: string };
      agent: AgentId;
      id: string;
    }
  | { kind: "new-conversation"; id: string }
  | { kind: "copy-session-id"; id: string }
  | { kind: "orchestrate"; repository: string; run: AgentId }
  | { kind: "take-over"; id: string };
