export type TileContent =
  | { kind: "terminal"; session: string }
  | { kind: "preview"; preview: string };
export interface TileLeaf {
  kind: "tile";
  id: string;
  content: TileContent | null;
}
export interface TileSplit {
  kind: "split";
  id: string;
  direction: "horizontal" | "vertical";
  ratio: number;
  first: TileNode;
  second: TileNode;
}
export type TileNode = TileLeaf | TileSplit;
export interface TileLayout {
  sidebarCollapsed?: boolean;
  sidebarWidth?: number | undefined;
  tree: TileNode;
  focused: string;
  maximized: string | null;
  landing?: string | undefined;
}
export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type TileDirection = "left" | "up" | "right" | "down";
export type DropZone = "center" | "left" | "right" | "up" | "down";
export type TileDrag = { kind: "tile" | "session" | "preview"; id: string };

export type TileAction =
  | TileDirection
  | TileSplit["direction"]
  | `grow-${TileDirection}`
  | "close-space"
  | "new-shell"
  | "maximize"
  | "hide"
  | "close"
  | "popout";

/** CSS pixels, measured against the unmaximized board. */
export interface TileMetrics {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
}

export interface TilePlacement {
  metrics?: TileMetrics | undefined;
  /** Available tile-area width in terminal character cells at the current font size. */
  columns: number;
  needsYou?: ReadonlySet<string>;
  /** Background arrivals must preserve the user's current terminal. */
  preserveFocus?: boolean;
  focusedAt?: ReadonlyMap<string, number>;
}
