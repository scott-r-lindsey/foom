import type { ConfirmationClient } from "../../shared/confirmation";
import type { BoardCommand } from "../../shared/board-command";
import type { SidebarRepository } from "./sidebar.d";
import type { SidebarCommand } from "../../shared/workspace";
import type { BoardRow } from "./board.d";
import type { TerminalViewSource } from "../terminal/terminal-view-source.d";
import type { TerminalActivity } from "../../shared/desktop";

import type { AgentInstallation, AgentId } from "../../shared/agents";
import type { Repository } from "../../shared/worktrees";
import type { StartWorktreeRequest } from "../../shared/workspace";
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
  start(request: StartWorktreeRequest): Promise<void>;
  remove(id: string): Promise<boolean>;
}
/** Samples and the live source share rows, verdicts, activity batches and tails. */
export interface BoardSource {
  confirmations?: ConfirmationClient;
  isReady?: () => boolean;
  connect?: () => () => void;
  createView?: () => TerminalViewSource;
  getSidebar?: () => SidebarRepository[] | readonly SidebarRepository[];
  sidebarCommand?: (command: SidebarCommand) => Promise<void>;
  shellName?: () => string;

  getSnapshot: () => readonly BoardRow[];
  getRepositories?: () => readonly string[];
  subscribeCommands?: (listener: (command: BoardCommand) => void) => () => void;
  subscribe: (listener: () => void) => () => void;
  subscribeActivity(listener: (batch: readonly TerminalActivity[]) => void): () => void;
  tail(id: string): Promise<readonly string[]>;
  markSeen(id: string): void;
  resolve(id: string, reason: string): void | Promise<void>;
  worktrees?: WorktreeSource;
  shell?: { restart(): Promise<void> };
}
