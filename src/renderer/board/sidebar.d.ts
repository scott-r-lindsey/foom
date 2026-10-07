import type { Repository, Worktree } from "../../shared/worktrees";
import type { BoardRow } from "./board.d";
export interface SidebarPreferences {
  pins: readonly string[];
  expanded: Readonly<Record<string, boolean>>;
  names: Readonly<Record<string, string>>;
}
export interface SidebarWorktree extends Worktree {
  removed?: boolean;
}
export interface SidebarRepository extends Repository {
  worktrees: readonly SidebarWorktree[];
}
export type SidebarLocation = { repository: string; worktree?: string };
export interface SidebarTree {
  repository: SidebarRepository;
  section: number;
  expanded: boolean;
  pinned: boolean;
  rollup: BoardRow | undefined;
  worktrees: {
    tree: SidebarWorktree;
    expanded: boolean;
    rollup: BoardRow | undefined;
    sessions: readonly BoardRow[];
  }[];
}
