import type { BoardRow } from "./board.d";
import type { ShellView } from "../terminal/shell.d";
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
  load(): Promise<LaunchOptions>;
  addRepository(): Promise<Repository | null>;
  start(request: StartWorktreeRequest): Promise<void>;
  remove(id: string): Promise<boolean>;
}
/** Samples and the live source share rows, verdicts, activity batches and tails. */
export interface BoardSource {
  getSnapshot: () => readonly BoardRow[];
  subscribe: (listener: () => void) => () => void;
  subscribeActivity(listener: (batch: readonly TerminalActivity[]) => void): () => void;
  tail(id: string): Promise<readonly string[]>;
  markSeen(id: string): void;
  resolve(id: string, reason: string): void | Promise<void>;
  worktrees?: WorktreeSource;
  shell?: {
    mount(element: HTMLElement, onHide: () => void): () => void;
    getSnapshot: () => ShellView;
    subscribe: (listener: () => void) => () => void;
    open(id?: string): Promise<void>;
    hide(): Promise<void>;
    toggle(): Promise<void>;
    restart(): Promise<void>;
  };
}
