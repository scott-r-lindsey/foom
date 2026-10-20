import type { Dispatch, RefObject, SetStateAction } from "react";
import type { SidebarCommand } from "../../shared/workspace";
import type { BoardSource } from "./board-source.d";
import type { BoardRow } from "./board.d";
import type { useBoardTiles } from "./use-board-tiles";

export interface BoardCommandContext
  extends Pick<
    ReturnType<typeof useBoardTiles>,
    "tileAction" | "changeLayout" | "layoutRef" | "setFocusRequest"
  > {
  source: BoardSource;
  inactive: boolean;
  focusedRow: BoardRow | undefined;
  setRemoveError: Dispatch<SetStateAction<string>>;
  selected: string | undefined;
  open: (row: BoardRow, replace?: boolean) => void;
  onSettings: ((section?: "config") => void) | undefined;
  onCloseSettings: (() => void) | undefined;
  settingsOpen: boolean;
  toggleSidebarRef: RefObject<(() => void) | undefined>;
  newWorktreeRef: RefObject<((repository?: string) => boolean) | undefined>;
  sidebarRef: RefObject<HTMLElement | null>;
  buttonsRef: RefObject<Map<string, HTMLElement>>;
  setLogOpen: Dispatch<SetStateAction<boolean>>;
  command: (value: SidebarCommand) => Promise<void>;
}
