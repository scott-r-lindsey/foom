import type { MoveContent, MovePlacement } from "../../shared/windows";
import type { TileLayout, TileNode, TilePlacement } from "./tiles.d";
import { dropTile, placeContent } from "./tiles";

// A destination learns the content identity only after main transfers ownership.
const placeholder = "foom-incoming-move";
export function prepareMove(
  layout: TileLayout,
  at: MovePlacement,
  options: TilePlacement,
): TileLayout | null {
  const next = at
    ? dropTile(layout, { kind: "session", id: placeholder }, at.tile, at.zone)
    : placeContent(layout, { kind: "terminal", session: placeholder }, false, options);
  return next === layout ? null : next;
}
export function finishMove(layout: TileLayout, content: MoveContent): TileLayout {
  const visit = (node: TileNode): TileNode =>
    node.kind === "split"
      ? { ...node, first: visit(node.first), second: visit(node.second) }
      : node.content?.kind === "terminal" && node.content.session === placeholder
        ? {
            ...node,
            content:
              content.kind === "terminal"
                ? { kind: "terminal", session: content.id }
                : { kind: "preview", preview: content.id },
          }
        : node;
  return { ...layout, tree: visit(layout.tree) };
}
