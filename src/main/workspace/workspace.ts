import type { RemoteTarget } from "../../shared/remote-host";
import type { SidebarCommandResult } from "../../shared/workspace";
import type { ActionLogPage } from "../../shared/action-log";
import type { AgentEvidence } from "../../shared/agent-detection";
import type { AgyPluginAction } from "../../shared/agy-plugin";
import type { ConfirmWorkspace, DialogContent } from "../../shared/confirmation";
import type { ShellState } from "../../shared/desktop";
import type { VerdictAction } from "../../shared/evaluator";
import type { ExecutionTransition } from "../../shared/execution";
import type { HookSignal } from "../../shared/hooks";
import type { Settings } from "../../shared/setup";
import type {
  AgentReport,
  LaunchRequest,
  McpConnection,
  SidebarCommand,
  SidebarInventory,
  StartWorktreeRequest,
  WorkspaceSnapshot,
} from "../../shared/workspace";
import type { BranchInventory, CreateOutcome, Repository, Worktree } from "../../shared/worktrees";
import type { Orchestration } from "../control/orchestration";
import { WorkspaceContext } from "./workspace-context";
import type { WorkspaceDependencies } from "./workspace-types";

/** Main-owned public workspace API; feature capabilities stay inside the coordinator. */
export class Workspace {
  private readonly owner: WorkspaceContext;
  readonly orchestration: Orchestration;
  constructor(deps: WorkspaceDependencies) {
    this.owner = new WorkspaceContext(deps);
    this.orchestration = this.owner.orchestration;
  }
  async startHostRecipe(target: RemoteTarget): Promise<string> {
    return this.owner.startHomeShell(undefined, target);
  }
  async initializeControl(): Promise<void> {
    return this.owner.initializeControl();
  }
  async messageBoard(method: string, input: unknown): Promise<unknown> {
    return this.owner.messageBoard(method, input);
  }

  async actionLog(query: unknown): Promise<ActionLogPage> {
    return this.owner.actionLog(query);
  }
  async clearActionLog(): Promise<void> {
    return this.owner.clearActionLog();
  }
  configure(
    settings: Pick<Settings, "hooks" | "agents"> &
      Partial<
        Pick<
          Settings,
          | "worktreeLocation"
          | "agentArguments"
          | "agentBypassIdentities"
          | "agentHooks"
          | "showNewChildren"
          | "closeFinishedAgents"
          | "restoreSessions"
          | "concurrentChildren"
          | "unreadChildMinutes"
          | "autoRemoveMergedWorktrees"
          | "showPullRequests"
        >
      >,
  ): void {
    this.owner.configure(settings);
  }
  async restore(): Promise<void> {
    return this.owner.restore();
  }
  ownsSession(id: string): boolean {
    return this.owner.ownsSession(id);
  }
  async prepareQuit(): Promise<void> {
    return this.owner.prepareQuit();
  }
  cancelQuit(): void {
    this.owner.cancelQuit();
  }
  restartSaved(): Promise<void> {
    return this.owner.restartSaved();
  }
  mcpConnectionChanged(id: string, state: McpConnection | undefined): void {
    this.owner.mcpConnectionChanged(id, state);
  }
  snapshot(): WorkspaceSnapshot {
    return this.owner.snapshot();
  }
  async addRepository(path: string): Promise<Repository> {
    return this.owner.addRepository(path);
  }
  focusOrchestrator(id: string): void {
    this.owner.focusOrchestrator(id);
  }
  refresh(): void {
    this.owner.refresh();
  }
  async removeRepository(repository: string, confirm?: () => Promise<boolean>): Promise<void> {
    return this.owner.removeRepository(repository, confirm);
  }
  async worktrees(repository: string): Promise<readonly Worktree[]> {
    return this.owner.worktrees(repository);
  }
  async branches(repository: string): Promise<BranchInventory> {
    return this.owner.branches(repository);
  }
  async createWorktree(
    repository: string,
    branch: string,
    location?: "root" | "adjacent",
  ): Promise<Worktree & { outcome: CreateOutcome }> {
    return this.owner.createWorktree(repository, branch, location);
  }
  async scanAgents(refresh: boolean): Promise<AgentReport> {
    return this.owner.scanAgents(refresh);
  }
  async changeAgentSetup(
    id: string,
    action: string,
    confirm: (content: DialogContent) => Promise<boolean>,
  ): Promise<AgentReport> {
    return this.owner.changeAgentSetup(id, action, confirm);
  }
  async changeAgyPlugin(
    action: AgyPluginAction,
    confirm?: () => Promise<boolean>,
  ): Promise<AgentReport> {
    return this.owner.changeAgyPlugin(action, confirm);
  }
  async launch(
    request: LaunchRequest,
    confirm?: ConfirmWorkspace,
  ): Promise<{ id: string; attention: "hooks" | "evaluator" } | null> {
    return this.owner.launch(request, confirm);
  }
  async startWorktree(
    request: StartWorktreeRequest,
    confirm?: ConfirmWorkspace,
  ): Promise<string | null> {
    return this.owner.startWorktree(request, confirm);
  }
  async removeWorktree(
    id: string,
    confirm: (branch: string, changes: string) => Promise<boolean>,
  ): Promise<boolean> {
    return this.owner.removeWorktree(id, confirm);
  }
  panelFacts(repository: string, worktree: string) {
    return this.owner.panelFacts(repository, worktree);
  }
  async sidebarInventory(): Promise<SidebarInventory> {
    return this.owner.sidebarInventory();
  }
  async sidebarCommand(
    command: Exclude<SidebarCommand, { kind: "open-handoff-link" }>,
    confirm: ConfirmWorkspace,
  ): Promise<SidebarCommandResult> {
    return this.owner.sidebarCommand(command, confirm);
  }
  subscribeExecution(listener: (event: ExecutionTransition) => void): () => void {
    return this.owner.subscribeExecution(listener);
  }
  foreground(id: string, name: string): void {
    this.owner.foreground(id, name);
  }
  shellState(id: string, state: ShellState): void {
    this.owner.shellState(id, state);
  }
  output(id: string): void {
    this.owner.output(id);
  }
  evidence(id: string, evidence: AgentEvidence, initial?: boolean): Promise<void> {
    return this.owner.evidence(id, evidence, initial);
  }
  quiet(id: string): Promise<void> {
    return this.owner.quiet(id);
  }
  hook(signal: HookSignal): Promise<void> {
    return this.owner.hook(signal);
  }
  exited(id: string, code: number): Promise<void> {
    return this.owner.exited(id, code);
  }
  removed(id: string): void {
    this.owner.removed(id);
  }
  input(id: string): void {
    this.owner.input(id);
  }
  feedback(id: string, verdictId: string | null, action: VerdictAction): Promise<void> {
    return this.owner.feedback(id, verdictId, action);
  }
  async dispose(): Promise<void> {
    return this.owner.dispose();
  }
}
