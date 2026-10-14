import type { PreviewApi } from "../../shared/previews";
import type { PreviewSummary } from "../../shared/workspace";
import type { ActionLogApi } from "../../shared/action-log";
import type { GitPanelFacts, HomeShellFacts } from "../../shared/panel";
import type { WindowsApi } from "../../shared/windows";
import type { AppMenuApi } from "../../shared/app-menu";
import type { ConfirmationClient } from "../../shared/confirmation";
import type { BoardCommand } from "../../shared/board-command";
import type { SidebarRepository } from "./sidebar.d";
import type { SidebarCommand } from "../../shared/workspace";
import type { BoardRow } from "./board.d";
import type { TerminalViewSource } from "../terminal/terminal-view-source.d";
import type { TerminalActivity } from "../../shared/desktop";
import type { ConfigStatus } from "../../shared/foom-config";

import type { AgentInstallation, AgentId } from "../../shared/agents";
import type { BranchInventory, CreateOutcome, Repository, Worktree } from "../../shared/worktrees";
export interface LaunchOptions {
  repositories: readonly Repository[];
  agents: readonly AgentInstallation[];
  enabled: Readonly<Record<AgentId, boolean>>;
  hooks: boolean;
  acknowledged: boolean;
}
export interface WorktreeSource {
  confirmations?: ConfirmationClient;
  load(): Promise<LaunchOptions>;
  addRepository(): Promise<Repository | null>;
  /** Local refs for the branch field. */
  branches(repository: string): Promise<BranchInventory>;
  /** Create only; resolves once the sidebar lists the worktree. */
  create(repository: string, branch: string): Promise<Worktree & { outcome: CreateOutcome }>;
  remove(id: string): Promise<boolean>;
}
/** Samples and the live source share rows, verdicts and activity batches. */
export interface BoardSource {
  previews?: {
    getSnapshot(): readonly PreviewSummary[];
    close(id: string): Promise<void>;
    onPlace?: PreviewApi["onPlace"];
  };
  actionLog?: ActionLogApi;
  windows?: WindowsApi;
  appMenu?: AppMenuApi;
  confirmations?: ConfirmationClient;
  readonly isDevelopment?: boolean;
  isReady?: () => boolean;
  connect?: () => () => void;
  createView?: () => TerminalViewSource;
  getSidebar?: () => SidebarRepository[] | readonly SidebarRepository[];
  sidebarCommand?: (command: SidebarCommand) => Promise<void>;
  panelFacts?: (repository: string, worktree: string) => Promise<GitPanelFacts>;
  homeShell?: () => HomeShellFacts | undefined;
  shellName?: () => string;
  config?: {
    status(): Promise<ConfigStatus>;
    subscribe(listener: (status: ConfigStatus) => void): () => void;
    openFolder(): Promise<void>;
  };

  getSnapshot: () => readonly BoardRow[];
  getRepositories?: () => readonly string[];
  subscribeCommands?: (listener: (command: BoardCommand) => void) => () => void;
  subscribe: (listener: () => void) => () => void;
  subscribeActivity(listener: (batch: readonly TerminalActivity[]) => void): () => void;
  markSeen(id: string): void;
  resolve(id: string, reason: string): void | Promise<void>;
  worktrees?: WorktreeSource;
  shell?: { restart(): Promise<void> };
}
