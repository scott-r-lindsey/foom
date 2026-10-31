import type { AgentId } from "../../shared/agents";
import type { Settings } from "../../shared/setup";
import type { WorkspaceSnapshot, WorkspaceTerminal } from "../../shared/workspace";
import type { AgyPlugin } from "../agents/agy-plugin";
import type { AgentProbes } from "../agents/probes";
import type { ProbeHttp } from "../agents/probe-http";
import type { Orchestration } from "../control/orchestration";
import type { OrchestrationHost } from "../control/orchestration.d";
import type { ControlRuntime } from "../control/runtime";
import type { CleanupOwner } from "./cleanup-owner";
import type { ExecutionOwner } from "./execution-owner";
import type { SessionOwner } from "./session-owner";
import type { SessionLifecycle } from "./session-lifecycle";
import type { homeShellFacts } from "./home-shell";
import type { Agents, WorkspaceDependencies, WorkspaceMethods } from "./workspace-types";

/** Independent feature contracts. Shared mutable state remains owned by the composer. */
export interface WorktreeLaunchContext {
  readonly addWorktree: WorkspaceMethods["addWorktree"];
  readonly agents: Pick<Agents, "launch">;
  readonly busyWorktrees: Set<string>;
  readonly confirmAgentLaunch: WorkspaceMethods["confirmAgentLaunch"];
  readonly defaultArguments: Settings["agentArguments"];
  readonly enabled: Readonly<Record<AgentId, boolean>>;
  readonly executionOwner: Pick<
    ExecutionOwner,
    "ensure" | "launched" | "markExited" | "reset" | "view"
  >;
  readonly known: WorkspaceMethods["known"];
  readonly launchAgent: WorkspaceMethods["launchAgent"];
  readonly launched: Map<string, WorkspaceTerminal>;
  readonly location: "root" | "adjacent";
  readonly now: () => number;
  readonly orchestration: Pick<
    Orchestration,
    "relaunched" | "view" | "exited" | "remoteParentGuard" | "remoteCheckout" | "worktreeHost"
  >;
  readonly persist: () => void;
  readonly queues: Map<string, Promise<void>>;
  readonly refresh: () => void;
  readonly replacementVersion: WorkspaceMethods["replacementVersion"];
  readonly resumeStarts: Map<string, Promise<void>>;
  readonly scanAgents: WorkspaceMethods["scanAgents"];
  readonly sessions: Pick<SessionOwner, "rememberIdentity" | "rememberRemote">;
  readonly shellEnvironment: WorkspaceMethods["shellEnvironment"];
  readonly startExisting: WorkspaceMethods["startExisting"];
  readonly startShell: WorkspaceMethods["startShell"];
  readonly withRepository: <T>(repository: string, work: () => Promise<T>) => Promise<T>;
  readonly worktrees: WorkspaceMethods["worktrees"];
  readonly deps: {
    readonly worktrees: Pick<
      WorkspaceDependencies["worktrees"],
      "launchIdentity" | "listWorktrees" | "validateBranch"
    >;
    readonly environment: WorkspaceDependencies["environment"];
    readonly terminals: Pick<WorkspaceDependencies["terminals"], "create" | "kill">;
    readonly reveal: WorkspaceDependencies["reveal"];
    readonly verdicts: Pick<WorkspaceDependencies["verdicts"], "forget">;
    readonly onChange: WorkspaceDependencies["onChange"];
  };
}

export interface AgentSetupContext {
  readonly agentHooks: Readonly<Record<string, boolean>>;
  readonly agents: Pick<Agents, "scan">;
  readonly agyPlugin: Pick<AgyPlugin, "change">;
  readonly closed: boolean;
  readonly enabled: Readonly<Record<AgentId, boolean>>;
  readonly hooksEnabled: boolean;
  readonly launchAbort: AbortController;
  readonly scanAgents: WorkspaceMethods["scanAgents"];
  scanned: ReturnType<Agents["scan"]> | undefined;
  scannedProviders: number;
  readonly deps: {
    readonly agentPluginDirectory: WorkspaceDependencies["agentPluginDirectory"];
    readonly pluginStagingRoot: WorkspaceDependencies["pluginStagingRoot"];
    readonly onChange: WorkspaceDependencies["onChange"];
    readonly acknowledgeAgyPluginOffer: WorkspaceDependencies["acknowledgeAgyPluginOffer"];
  };
}

export interface SidebarCommandsContext {
  readonly auditHuman: WorkspaceMethods["auditHuman"];
  readonly busySessions: Set<string>;
  readonly busyWorktrees: Set<string>;
  readonly cleanup: Pick<
    CleanupOwner,
    "deleteMerged" | "inventory" | "removeIdleTree" | "removeOwnedTree"
  >;
  readonly closed: boolean;
  readonly control: Promise<Partial<Pick<ControlRuntime, "takeOver">>> | undefined;
  readonly executionOwner: Pick<ExecutionOwner, "view">;
  homeFacts: ReturnType<typeof homeShellFacts> | undefined;
  readonly known: WorkspaceMethods["known"];
  readonly launched: Map<string, WorkspaceTerminal>;
  readonly makeOrchestrator: WorkspaceMethods["makeOrchestrator"];
  readonly orchestration: Pick<Orchestration, "stopReviews" | "takeOver" | "view">;
  readonly refresh: () => void;
  readonly removeRepository: (
    repository: string,
    confirm?: () => Promise<boolean>,
  ) => Promise<void>;
  readonly removed: WorkspaceMethods["removed"];
  readonly resumeId: WorkspaceMethods["resumeId"];
  readonly revokeOrchestrator: WorkspaceMethods["revokeOrchestrator"];
  readonly snapshot: () => WorkspaceSnapshot;
  readonly startConfig: WorkspaceMethods["startConfig"];
  readonly startExisting: WorkspaceMethods["startExisting"];
  readonly startHomeShell: WorkspaceMethods["startHomeShell"];
  readonly withRepository: <T>(repository: string, work: () => Promise<T>) => Promise<T>;
  readonly worktrees: WorkspaceMethods["worktrees"];
  readonly deps: {
    readonly worktrees: Pick<
      WorkspaceDependencies["worktrees"],
      | "cleanupBrokenWorktree"
      | "launchIdentity"
      | "listRepositories"
      | "pruneWorktree"
      | "reviewIdentity"
    >;
    readonly forge:
      | Pick<
          NonNullable<WorkspaceDependencies["forge"]>,
          "boardEnabled" | "readBoard" | "readUrl" | "sync"
        >
      | undefined;
    readonly config: Pick<NonNullable<WorkspaceDependencies["config"]>, "root"> | undefined;
    readonly dialog: WorkspaceDependencies["dialog"];
    readonly copyText: WorkspaceDependencies["copyText"];
    readonly openExternal: WorkspaceDependencies["openExternal"];
    readonly terminals: Pick<WorkspaceDependencies["terminals"], "kill" | "stop">;
  };
}

export interface ConfigLaunchContext {
  readonly agents: Pick<Agents, "launch">;
  readonly bindConfig: WorkspaceMethods["bindConfig"];
  readonly closed: boolean;
  readonly configCredential: WorkspaceMethods["configCredential"];
  readonly configTokens: Map<string, string>;
  readonly defaultArguments: Settings["agentArguments"];
  readonly enabled: Readonly<Record<AgentId, boolean>>;
  readonly ensureProbeOpen: WorkspaceMethods["ensureProbeOpen"];
  readonly executionOwner: Pick<ExecutionOwner, "launched" | "markExited" | "reset" | "view">;
  readonly input: WorkspaceMethods["input"];
  readonly launched: Map<string, WorkspaceTerminal>;
  readonly now: () => number;
  readonly persist: () => void;
  probeHttp: Promise<ProbeHttp> | undefined;
  readonly probeIds: Set<string>;
  probes: AgentProbes | undefined;
  readonly queues: Map<string, Promise<void>>;
  readonly refresh: () => void;
  readonly removed: WorkspaceMethods["removed"];
  readonly scanAgents: WorkspaceMethods["scanAgents"];
  readonly startShell: WorkspaceMethods["startShell"];
  readonly deps: {
    readonly config: WorkspaceDependencies["config"];
    readonly terminals: Pick<WorkspaceDependencies["terminals"], "create" | "kill" | "stop"> & {
      readonly reply: WorkspaceDependencies["terminals"]["reply"];
      readonly screen: WorkspaceDependencies["terminals"]["screen"];
    };
    readonly placeChild: WorkspaceDependencies["placeChild"];
    readonly probeWaitingMs: WorkspaceDependencies["probeWaitingMs"];
    readonly verdicts: Pick<WorkspaceDependencies["verdicts"], "forget">;
    readonly environment: WorkspaceDependencies["environment"];
    readonly onChange: WorkspaceDependencies["onChange"];
  };
}

export interface RepositoryOperationsContext {
  readonly addWorktree: WorkspaceMethods["addWorktree"];
  readonly busyWorktrees: Set<string>;
  readonly cleanup: Pick<CleanupOwner, "removeIdleTree">;
  readonly launched: Map<string, WorkspaceTerminal>;
  readonly location: "root" | "adjacent";
  readonly refresh: () => void;
  readonly withRepository: <T>(repository: string, work: () => Promise<T>) => Promise<T>;
  readonly deps: {
    readonly worktrees: Pick<
      WorkspaceDependencies["worktrees"],
      "createWorktree" | "listWorktrees"
    >;
  };
}

export interface OrchestrationCommandsContext {
  readonly auditHuman: WorkspaceMethods["auditHuman"];
  readonly busyWorktrees: Set<string>;
  readonly control:
    | Promise<Pick<ControlRuntime, "setRole"> & Partial<Pick<ControlRuntime, "audit">>>
    | undefined;
  readonly executionOwner: Pick<ExecutionOwner, "markExited" | "reset" | "view">;
  readonly initializeControl: () => Promise<void>;
  readonly launchAgent: WorkspaceMethods["launchAgent"];
  readonly launched: Map<string, WorkspaceTerminal>;
  readonly location: "root" | "adjacent";
  readonly orchestration: Pick<
    Orchestration,
    "active" | "handoffs" | "reserve" | "reviews" | "revoke" | "view"
  >;
  readonly queues: Map<string, Promise<void>>;
  readonly refresh: () => void;
  readonly revokeOrchestrator: WorkspaceMethods["revokeOrchestrator"];
  readonly sessions: Pick<SessionOwner, "isRestoring" | "rememberIdentity">;
  readonly withRepository: <T>(repository: string, work: () => Promise<T>) => Promise<T>;
  readonly worktrees: WorkspaceMethods["worktrees"];
  readonly deps: {
    readonly worktrees: Pick<
      WorkspaceDependencies["worktrees"],
      "createWorktree" | "launchIdentity" | "listWorktrees" | "validateBranch"
    >;
    readonly terminals: Pick<WorkspaceDependencies["terminals"], "kill">;
    readonly verdicts: Pick<WorkspaceDependencies["verdicts"], "forget">;
  };
}

export interface ExecutionEventsContext {
  readonly closed: boolean;
  readonly configTokens: Map<string, string>;
  readonly executionOwner: Pick<
    ExecutionOwner,
    | "currentState"
    | "evidence"
    | "feedback"
    | "foreground"
    | "has"
    | "hook"
    | "input"
    | "output"
    | "quiet"
    | "removed"
    | "shellState"
  >;
  readonly hookKeys: Map<string, string>;
  readonly launched: Map<string, WorkspaceTerminal>;
  readonly lifecycle: Pick<SessionLifecycle, "exited" | "removed">;
  readonly orchestration: Pick<Orchestration, "removed">;
  readonly persist: () => void;
  readonly probeIds: Set<string>;
  probes: AgentProbes | undefined;
  readonly queues: Map<string, Promise<void>>;
  readonly refresh: () => void;
  readonly deps: {
    readonly onChange: WorkspaceDependencies["onChange"];
  };
}

export interface OrchestrationHostContext {
  readonly launchAgent: WorkspaceMethods["launchAgent"];
  readonly busyWorktrees: Set<string>;
  readonly cleanup: Pick<CleanupOwner, "removeOwnedTree">;
  readonly closed: boolean;
  readonly control:
    | Promise<{ readonly audit?: Pick<ControlRuntime["audit"], "handoff"> }>
    | undefined;
  readonly createChildWorktree: WorkspaceMethods["createChildWorktree"];
  readonly defaultArguments: Settings["agentArguments"];
  readonly input: WorkspaceMethods["input"];
  readonly launchChild: WorkspaceMethods["launchChild"];
  readonly location: "root" | "adjacent";
  readonly persist: () => void;
  readonly refresh: () => void;
  readonly scanAgents: WorkspaceMethods["scanAgents"];
  readonly sessions: Pick<SessionOwner, "isRestoring" | "save">;
  readonly showNewChildren: boolean;
  readonly sidebarCommand: WorkspaceMethods["sidebarCommand"];
  readonly snapshot: () => WorkspaceSnapshot;
  readonly withRepository: <T>(repository: string, work: () => Promise<T>) => Promise<T>;
  readonly deps: {
    readonly hosts: WorkspaceDependencies["hosts"];
    readonly forge: OrchestrationHost["forge"];
    readonly worktrees: Pick<
      WorkspaceDependencies["worktrees"],
      "adoptionBranch" | "adoptWorktree" | "listWorktrees" | "launchIdentity" | "reviewBranch"
    >;
    readonly terminals: Pick<WorkspaceDependencies["terminals"], "stop" | "tail"> & {
      readonly childInput: WorkspaceDependencies["terminals"]["childInput"];
    };
    readonly placeChild: WorkspaceDependencies["placeChild"];
    readonly reveal: WorkspaceDependencies["reveal"];
    readonly dialog: WorkspaceDependencies["dialog"];
  };
}
