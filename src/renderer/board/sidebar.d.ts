import type { Repository, Worktree } from "../../shared/worktrees";
import type { BoardRow } from "./board.d";
export interface SidebarPreferences {
  pins: readonly string[];
  expanded: Readonly<Record<string, boolean>>;
  names: Readonly<Record<string, string>>;
}
export interface SidebarRepository extends Repository {
  worktrees: readonly Worktree[];
}
export type SidebarLocation = { repository: string; worktree?: string };
export interface SidebarTree {
  repository: SidebarRepository;
  section: number;
  expanded: boolean;
  pinned: boolean;
  rollup: BoardRow | undefined;
  worktrees: {
    tree: Worktree;
    expanded: boolean;
    rollup: BoardRow | undefined;
    sessions: readonly BoardRow[];
  }[];
}
