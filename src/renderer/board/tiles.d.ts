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
  tree: TileNode;
  focused: string;
  maximized: string | null;
  landing?: string;
}
export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type DropZone = "center" | "left" | "right" | "up" | "down";
export type TileDrag = { kind: "tile" | "session"; id: string };

export type TileAction =
  | "right"
  | "down"
  | "growx"
  | "growy"
  | "maximize"
  | "hide"
  | "close"
  | "popout";

export interface TilePlacement {
  /** Available tile-area width in terminal character cells at the current font size. */
  columns: number;
  needsYou?: ReadonlySet<string>;
  /** Background arrivals must preserve the user's current terminal. */
  preserveFocus?: boolean;
  focusedAt?: ReadonlyMap<string, number>;
}
