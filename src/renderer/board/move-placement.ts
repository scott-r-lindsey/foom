import type { MoveContent, MovePlacement } from "../../shared/windows";
import type { TileContent, TileLayout, TileNode, TilePlacement } from "./tiles.d";
import { contentId, dropTile, placeContent } from "./tiles";

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
  const incoming: TileContent =
    content.kind === "terminal"
      ? { kind: "terminal", session: content.id }
      : { kind: "preview", preview: content.id };
  const visit = (node: TileNode): TileNode => {
    if (node.kind === "split")
      return { ...node, first: visit(node.first), second: visit(node.second) };
    if (node.content?.kind === "terminal" && node.content.session === placeholder)
      return { ...node, content: incoming };
    // A delayed inventory/reservation reply may leave an old local assignment.
    // Preserve geometry while keeping each content identity unique on commit.
    if (node.content?.kind === content.kind && contentId(node.content) === content.id)
      return { ...node, content: null };
    return node;
  };
  return { ...layout, tree: visit(layout.tree) };
}
