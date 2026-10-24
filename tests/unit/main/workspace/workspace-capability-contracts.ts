import type {
  AgentSetupContext,
  ConfigLaunchContext,
  ExecutionEventsContext,
  OrchestrationCommandsContext,
  OrchestrationHostContext,
  RepositoryOperationsContext,
  SidebarCommandsContext,
  WorktreeLaunchContext,
} from "../../../../src/main/workspace/workspace-capabilities";

// Compilation fails if a feature regains the coordinator's dependency bundle or
// destructive service methods beyond its explicitly declared slice.
type Assert<T extends true> = T;
type Lacks<T, K extends PropertyKey> = Extract<keyof T, K> extends never ? true : false;
type CoordinatorEffects = "control" | "receiver" | "agents" | "sessions" | "watcher";
type RemovalEffects = "removeRepository" | "removeWorktree" | "cleanupBrokenWorktree";
export type AgentSetupFixture = Assert<Lacks<AgentSetupContext["deps"], CoordinatorEffects>>;
export type ExecutionFixture = Assert<Lacks<ExecutionEventsContext["deps"], CoordinatorEffects>>;
export type ConfigFixture = Assert<Lacks<ConfigLaunchContext["deps"], CoordinatorEffects>>;
export type SidebarFixture = Assert<Lacks<SidebarCommandsContext["deps"], CoordinatorEffects>>;
export type LaunchFixture = Assert<
  Lacks<WorktreeLaunchContext["deps"]["worktrees"], RemovalEffects>
>;
export type RepositoryFixture = Assert<
  Lacks<RepositoryOperationsContext["deps"]["worktrees"], RemovalEffects>
>;
export type OrchestrationFixture = Assert<
  Lacks<OrchestrationCommandsContext["deps"]["worktrees"], RemovalEffects>
>;
export type HostFixture = Assert<
  Lacks<OrchestrationHostContext["deps"]["worktrees"], RemovalEffects>
>;
