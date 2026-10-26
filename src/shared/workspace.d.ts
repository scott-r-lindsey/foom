import type { LaunchSelection } from "./agents";
import type { ReviewState } from "./review";
import type { Handoff } from "./handoff";
import type { PreviewOpenAction } from "./previews";
import type { ActionLogQuery, ActionLogPage } from "./action-log";
import type { CleanupProgress } from "./cleanup";
import type { GitPanelFacts, HomeShellFacts } from "./panel";
import type { AgyPluginAction } from "./agy-plugin";
import type { ExecutionSnapshot, ExecutionTransition } from "./execution";
import type { ConfirmationClient } from "./confirmation";
import type { AgentId, AgentInstallation } from "./agents";
import type { AttentionKind, VerdictAction, VerdictState } from "./evaluator";
import type { BranchInventory, CreateOutcome, Repository, Worktree } from "./worktrees";

/**
 * Main's latest view of a terminal's attention state. `verdictId` is null for user
 * actions and for verdicts that couldn't be stored.
 */
export interface TerminalState {
  /** Main-derived board presentation only; does not alter the evaluator verdict. */
  waitingOn?: number;
  outputRevision?: number;
  inputRevision?: number;
  execution?: ExecutionSnapshot | undefined;
  attentionKind?: AttentionKind;
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
  /** Host-observed foreground process name; never persisted. */
  foregroundProgram?: string;
  outputRevision?: number;
  inputRevision?: number;
  /** Main-observed attachment for this live launch; never persisted. */
  mcpConnection?: McpConnection | undefined;
  execution?: ExecutionSnapshot | undefined;
  attentionKind?: AttentionKind;
  id: string;
  kind: "agent" | "shell";
  agent: AgentId;
  /** Metadata only: preserves unavailable config-agent rows, never launch authority. */
  providerOrigin?: "config" | "bundled";
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
  /** Transient probe; excluded from saved sessions. */
  probe?: boolean;
  /** Public identity of the config session driving this transient probe. */
  probeOwner?: string;
  probeNote?: boolean;
  startedAt?: number;
  exitCode?: number | undefined;
  launchFlags?: readonly string[];
  /** Requested per-child options, not a claim about the provider's actual model. */
  selection?: LaunchSelection;
  /** Names of the variables Foom set from Environment settings; never values. */
  environment?: readonly string[];
  /** Main-computed orchestration role and visible action history; never persisted. */
  orchestration?: OrchestrationView;
  /** Latest child-authored report, displayed only as inert text and validated links. */
  handoff?: Handoff;
  review?: ReviewState;
  roleNotRestored?: boolean;
}

/** One orchestrator action. Labels are redacted, bounded metadata, never prompts or output. */
export interface OrchestrationEntry {
  id: string;
  action:
    | "create_worktree"
    | "launch"
    | "stop"
    | "close"
    | "remove_worktree"
    | "prompt"
    | "send_keys"
    | "reply"
    | "take_over";
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
}

export interface StartWorktreeRequest {
  repository: string;
  branch: string;
  run: AgentId;
}

export interface WorkspaceApi {
  onFocusWorktree?(callback: (path: string) => void): () => void;
  actionLog(query: ActionLogQuery): Promise<ActionLogPage>;
  clearActionLog(): Promise<void>;
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
  changeAgentSetup(id: string, action: string): Promise<AgentReport>;
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
  previewActions?: readonly PreviewOpenAction[];
  previews?: readonly PreviewSummary[];
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
  | { kind: "open-handoff-link"; id: string; seq: number; index: number }
  | { kind: "home-shell" }
  | { kind: "copy-home-path" }
  | { kind: "config-launch"; run: AgentId }
  | { kind: "copy-config-path" }
  | { kind: "open-pull-request"; repository: string; worktree: string }
  | { kind: "copy-worktree-path"; repository: string; worktree: string }
  | { kind: "launch"; repository: string; worktree: string; run: AgentId }
  | { kind: "remove-worktree"; repository: string; worktree: string }
  | { kind: "cleanup-worktree"; repository: string; worktree: string }
  | { kind: "prune-worktree"; repository: string; worktree: string }
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
  | { kind: "make-orchestrator"; id: string }
  | { kind: "revoke-orchestrator"; id: string }
  | { kind: "take-over"; id: string };

/** Main-owned display facts. An opaque ID grants no filesystem capability. */
export interface PreviewSummary {
  openedBy?: { terminalId: string; agent: string };
  network: boolean;
  id: string;
  repository: string;
  worktree: string;
  relativePath: string;
  kind: "markdown" | "html";
}
