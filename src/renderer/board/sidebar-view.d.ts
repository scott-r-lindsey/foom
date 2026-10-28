import type { ReactNode, RefObject } from "react";
import type { PreviewSummary, SidebarCommand } from "../../shared/workspace";
import type { BoardSource, LaunchOptions } from "./board-source.d";
import type { BoardRow } from "./board.d";
import type { SidebarPreferences } from "./sidebar.d";

export interface SidebarProps {
  source: BoardSource;
  configPanelRef?: RefObject<(() => void) | undefined>;
  collapsed?: boolean;
  width?: number | undefined;
  setWidth?: (width: number) => void;
  setCollapsed?: (value: boolean) => void;
  toggleRef?: RefObject<(() => void) | undefined>;
  onCompact?: (value: boolean) => void;
  dragging?: boolean;
  inactive: boolean;
  revealRef: RefObject<((row: BoardRow) => void) | undefined>;
  rows: readonly BoardRow[];
  preferences: SidebarPreferences;
  save: (next: SidebarPreferences) => void;
  selected: string | undefined;
  buttons: RefObject<Map<string, HTMLElement>>;
  sidebar: RefObject<HTMLElement | null>;
  open: (row: BoardRow) => void;
  focus: (id: string) => void;
  /** Opens a repository's panel with the branch field; false when there is no repository. */
  newWorktreeRef?: RefObject<((repository?: string) => boolean) | undefined>;
  command: (command: SidebarCommand) => Promise<void>;
  options: LaunchOptions | undefined;
  footer: ReactNode;
  otherViews?: ReadonlySet<string>;
  previews?: readonly PreviewSummary[];
  openPreview?: (id: string) => void;
  pickPreview?: (worktree: string) => Promise<void>;
  tileNumbers?: ReadonlyMap<string, { number: number; focused: boolean }>;
  openSettings?: (section?: "config") => void;
}
