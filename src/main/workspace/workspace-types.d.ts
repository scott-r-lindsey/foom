import type { RemoteTarget } from "../../shared/remote-host";
import type { ReviewSnapshot } from "../control/review-loops.d";
import type { Orchestration } from "../control/orchestration";
import type { Hosts } from "../setup/hosts";
import type { SidebarCommandResult } from "../../shared/workspace";
import type { AgentEvidence } from "../../shared/agent-detection";
import type { AgentHooks, AgentId, AgentLaunch } from "../../shared/agents";
import type { AgyPluginAction } from "../../shared/agy-plugin";
import type { ChildInput } from "../../shared/child-input";
import type { ConfirmWorkspace, DialogContent } from "../../shared/confirmation";
import type { ShellState, TerminalSpec } from "../../shared/desktop";
import type { EnvironmentVariable } from "../../shared/environment";
import type { EvaluationInput, VerdictAction, VerdictRecord } from "../../shared/evaluator";
import type { ExecutionTransition } from "../../shared/execution";
import type { ConfigStatus } from "../../shared/foom-config";
import type { HookSignal } from "../../shared/hooks";
import type {
  AgentReport,
  LaunchRequest,
  SidebarCommand,
  SidebarInventory,
  StartWorktreeRequest,
  TerminalState,
  WorkspaceTerminal,
} from "../../shared/workspace";
import type { BranchInventory, CreateOutcome, Worktree } from "../../shared/worktrees";
import type { AgentService } from "../agents/agents";
import type { HookRegistrar } from "../agents/providers/hook-launch";
import type { ForgeTracking } from "../control/forge-tracking";
import type { ControlRuntime } from "../control/runtime";
import type { ControlLaunch } from "../control/types";
import type { InventoryWatch } from "./inventory-watch";
import type { SessionStore } from "./session-store";
import type { WorktreeService } from "./worktrees";

export interface WorkspaceMethods {
  enqueue(id: string, work: () => Promise<void>): Promise<void>;
  foreground(id: string, name: string): void;
  shellState(id: string, state: ShellState): void;
  output(id: string): void;
  evidence(id: string, evidence: AgentEvidence, initial?: boolean): Promise<void>;
  quiet(id: string): Promise<void>;
  hook(signal: HookSignal): Promise<void>;
  exited(id: string, code: number): Promise<void>;
  removed(id: string): void;
  input(id: string): void;
  feedback(id: string, verdictId: string | null, action: VerdictAction): Promise<void>;
  scanAgents(refresh: boolean): Promise<AgentReport>;
  changeAgentSetup(
    id: string,
    action: string,
    confirm: (content: DialogContent) => Promise<boolean>,
  ): Promise<AgentReport>;
  changeAgyPlugin(action: AgyPluginAction, confirm?: () => Promise<boolean>): Promise<AgentReport>;
  confirmAgentLaunch(worktree: string, confirm: ConfirmWorkspace): Promise<boolean>;
  launch(
    request: LaunchRequest,
    confirm?: ConfirmWorkspace,
  ): Promise<{ id: string; attention: "hooks" | "evaluator" } | null>;
  launchAgent(
    request: LaunchRequest,
    mainCheckout?: boolean,
    sharedCheckout?: boolean,
    checkoutIdentity?: string,
    replacement?: { id: string; conversationId?: string },
    extra?: Pick<
      AgentLaunch,
      | "control"
      | "prompt"
      | "conversationId"
      | "pinConversation"
      | "beforeSpawn"
      | "prepareSpawn"
      | "loop"
      | "selection"
      | "remoteCheckout"
    >,
  ): Promise<{ id: string; attention: "hooks" | "evaluator" }>;
  startWorktree(request: StartWorktreeRequest, confirm?: ConfirmWorkspace): Promise<string | null>;
  shellEnvironment(pathFirst?: string): Promise<{ env: Record<string, string>; names: string[] }>;
  replacementVersion(id: string | undefined): Pick<WorkspaceTerminal, "launchVersion">;
  startShell(
    location: Pick<WorkspaceTerminal, "repository" | "worktree" | "branch" | "home" | "config">,
    restoreId?: string,
    pathFirst?: string,
    configEnvironment?: Readonly<Record<string, string>>,
    checkout?: Awaited<ReturnType<Orchestration["remoteCheckout"]>>,
    remoteOverride?: RemoteTarget,
  ): Promise<string>;
  startHomeShell(restoreId?: string, remote?: RemoteTarget): Promise<string>;
  resumeId(
    command: Extract<SidebarCommand, { kind: "resume-id" }>,
    confirm: ConfirmWorkspace,
  ): Promise<void>;
  startExisting(
    repository: string,
    worktree: string,
    run: AgentId,
    confirm: ConfirmWorkspace,
    replacement?: { id: string; conversationId?: string },
    control?: AgentLaunch["control"],
    restoring?: boolean,
    authorityIdentity?: string,
    pastedId?: string,
  ): Promise<string | undefined>;
  revokeConfig(id: string): void;
  bindConfig(id: string, token: string): void;
  ensureProbeOpen(): void;
  configCredential(): Promise<{ token: string; env: Record<string, string> }>;
  startConfig(run: AgentId, replacement?: { id: string; conversationId?: string }): Promise<void>;
  probeState(id: string, state: TerminalState | null): TerminalState | null;
  sidebarInventory(): Promise<SidebarInventory>;
  sidebarCommand(
    command: Exclude<SidebarCommand, { kind: "open-handoff-link" }>,
    confirm: ConfirmWorkspace,
    validateClose?: () => void,
    closeSignal?: AbortSignal,
  ): Promise<SidebarCommandResult>;
  auditHuman(
    action: string,
    id: string,
    target: string | null,
    status: string,
    operationId: string,
  ): Promise<void>;
  orchestrationView(id: string): Pick<WorkspaceTerminal, "orchestration" | "handoff" | "review">;
  makeOrchestrator(id: string, confirm: ConfirmWorkspace): Promise<void>;
  revokeOrchestrator(id: string): Promise<void>;
  createChildWorktree(
    repository: string,
    branch: string,
  ): Promise<{ path: string; branch: string; identity: string }>;
  launchChild(
    parentId: string,
    repository: string,
    worktree: string,
    created: string,
    agent: AgentId,
    prompt: string | undefined,
    step?: {
      selection?: AgentLaunch["selection"];
      resume?: { id: string; conversationId: string };
      loop?: AgentLaunch["loop"];
      snapshot?: ReviewSnapshot;
      validate(): void;
    },
    remote?: AgentLaunch["remoteCheckout"],
  ): Promise<string>;
  known(repository: string): void;
  reserveRepositoryRemoval(repository: string, validate: () => void): () => void;
  worktrees(repository: string): Promise<readonly Worktree[]>;
  branches(repository: string): Promise<BranchInventory>;
  createWorktree(
    repository: string,
    branch: string,
    location?: "root" | "adjacent",
  ): Promise<Worktree & { outcome: CreateOutcome }>;
  addWorktree(
    repository: string,
    branch: string,
    location: "root" | "adjacent",
  ): Promise<Worktree & { outcome: CreateOutcome }>;
  removeWorktree(
    id: string,
    confirm: (branch: string, changes: string) => Promise<boolean>,
  ): Promise<boolean>;
  removeTree(
    repository: string,
    worktree: string,
    branch: string | null,
    confirm: (branch: string, changes: string, automatic?: boolean) => Promise<boolean>,
    revalidate?: () => void | Promise<void>,
    retainBranchLock?: (release: () => void) => void,
    autoApprove?: () => Promise<boolean>,
  ): Promise<boolean>;
  panelFacts(repository: string, worktree: string): ReturnType<WorktreeService["panelFacts"]>;
}
export type Agents = Pick<
  AgentService,
  "scan" | "launch" | "release" | "dispose" | "setHooksEnabled" | "setBypassIdentities"
>;
export interface WorkspaceDependencies {
  hosts?: Pick<Hosts, "fleet" | "worktree" | "registered" | "requireAgent"> &
    Partial<
      Pick<Hosts, "sessions" | "placement" | "rememberPlacement" | "worktrees" | "shellTarget">
    >;
  /** Main-owned clock budget; tests may inject a shorter probe reminder. */
  probeWaitingMs?: number;
  pluginStagingRoot?: string;
  worktrees: Pick<
    WorktreeService,
    | "listRepositories"
    | "addRepository"
    | "listWorktrees"
    | "branches"
    | "createWorktree"
    | "adoptWorktree"
    | "adoptionBranch"
    | "validateBranch"
    | "changes"
    | "cleanupChanges"
    | "cleanupStatus"
    | "cleanupBrokenWorktree"
    | "removalIdentity"
    | "launchIdentity"
    | "pruneWorktree"
    | "removeWorktree"
    | "removeRepository"
    | "mergedDefault"
    | "mergedFetchTime"
    | "mergedCommit"
    | "deleteMergedBranch"
    | "deleteMergedBranches"
    | "reviewBranch"
    | "reviewIdentity"
    | "canAutoRemoveReview"
    | "canAutoRemove"
    | "panelFacts"
  >;
  terminals: {
    create(spec: TerminalSpec): Promise<string>;
    kill(id: string, remoteHost?: string): Promise<void>;
    stop(id: string): Promise<boolean>;
    tail(id: string, lines: number): Promise<string[]>;
    childInput?(id: string, data: ChildInput): Promise<void>;
    reply?(id: string, data: string): Promise<void>;
    screen?(id: string): Promise<{ lines: string[]; title: string }>;
  };
  verdicts: {
    classify(input: EvaluationInput): Promise<VerdictRecord>;
    commit(record: VerdictRecord): Promise<void>;
    forget(terminalId: string): void;
    recordAction(
      terminalId: string,
      verdictId: string,
      action: VerdictAction,
      onlyIfPending?: boolean,
    ): Promise<void>;
  };
  /** Started on the first agent launch, independently of hook support. */
  control?: () => Promise<
    Pick<ControlRuntime, "prepare" | "close" | "setRole"> &
      Partial<Pick<ControlRuntime, "audit" | "takeOver" | "board">>
  >;
  /** Started on the first launch that attaches hooks, then reused. */
  agentPluginDirectory?: string;
  receiver: () => Promise<HookRegistrar & { close(): Promise<void> }>;
  /** Release checkout resources before Git removal; restore availability afterward. */
  prepareWorktreeRemoval?(worktree: string): Promise<() => void>;
  onExecution?(event: ExecutionTransition): void;
  onState(state: TerminalState): void;
  onChange?(): void;
  watcher?: Pick<InventoryWatch, "sync" | "dispose">;
  acknowledgeAgyPluginOffer?(): Promise<void>;
  forge?: ForgeTracking;
  openExternal?: (url: string) => Promise<void>;
  sessions?: Pick<SessionStore, "load" | "save" | "flush">;
  copyText?(text: string): void | Promise<void>;
  agents?: (
    prepare: (agent: AgentId) => Promise<AgentHooks>,
    control?: (
      repository: string,
      worktree: string,
      sessionId?: string,
      role?: AgentLaunch["control"],
    ) => Promise<ControlLaunch>,
  ) => Agents;
  /** The trusted app dialog, for confirmations no board click can answer. */
  dialog?: (content: DialogContent, signal: AbortSignal) => Promise<boolean>;
  /** Shows an existing session, for example a repository's running orchestrator. */
  reveal?: (id: string) => void;
  placeChild?: (id: string, parentId: string) => void;
  now?: () => number;
  /** Validated Environment layers for a launch: All sessions, then the agent's own. */
  environment?: (target: AgentId) => readonly (readonly EnvironmentVariable[])[];
  /** The Foom config folder: sessions there run without a repository or worktree. */
  config?: {
    root: string;
    cliDirectory: string;
    status?(): Promise<ConfigStatus>;
    probeNotice?(agent: string): Promise<boolean>;
    /** Throws when the folder is unavailable or sits inside a managed repository. */
    check(): Promise<void>;
  };
}
