export interface TileLeaf {
  kind: "tile";
  id: string;
  session: string | null;
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
  tree: TileNode;
  focused: string;
  maximized: string | null;
}
export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type TilePreset = "one" | "columns" | "rows" | "grid" | "main2" | "main3";
export type DropZone = "center" | "left" | "right" | "up" | "down";
export type TileDrag = { kind: "tile" | "session"; id: string };
