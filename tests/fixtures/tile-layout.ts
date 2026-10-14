import { leaves, splitTile } from "../../src/renderer/board/tiles";
import type { TileLayout } from "../../src/renderer/board/tiles.d";
export function arrangedLayout(
  layout: TileLayout,
  shape: "columns" | "rows" | "grid" | "main2" | "main3",
): TileLayout {
  const original = layout.focused;
  let next = splitTile(layout, shape === "rows" ? "vertical" : "horizontal");
  if (shape === "grid") next = splitTile(next, "vertical");
  if (shape === "grid" || shape === "main2" || shape === "main3") {
    const right = leaves(next.tree).at(-1);
    if (!right) throw new Error("Missing fixture tile");
    next = splitTile({ ...next, focused: right.id }, "vertical");
  }
  if (shape === "main3") {
    const last = leaves(next.tree).at(-1);
    if (!last) throw new Error("Missing fixture tile");
    next = splitTile({ ...next, focused: last.id }, "vertical");
  }
  return { tree: next.tree, focused: original, maximized: null };
}
