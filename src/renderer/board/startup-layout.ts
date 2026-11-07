import type { TileContent, TileNode, TileStartupReservation } from "./tiles.d";

function index(tree: TileNode, result = new Map<string, TileNode>()): Map<string, TileNode> {
  result.set(tree.id, tree);
  if (tree.kind === "split") {
    index(tree.first, result);
    index(tree.second, result);
  }
  return result;
}
const contentKey = (content: TileContent | null) =>
  content
    ? `${content.kind}:${content.kind === "terminal" ? content.session : content.preview}`
    : "";

/** Remove a failed presentation, retaining edits made after its placement. */
export function settledStartupTree(tree: TileNode, reservation: TileStartupReservation): TileNode {
  const before = index(reservation.before);
  const placed = index(reservation.placed);
  const expandedBlank =
    reservation.before.kind === "tile" &&
    reservation.before.content === null &&
    reservation.placed.kind === "split";
  const blank = (node: TileNode): TileNode => {
    // An explicitly split/moved subtree still needs an empty anchor after reload.
    const original = reservation.before;
    if (original.kind === "tile" && original.content === null && index(node).has(original.id))
      return original;
    while (node.kind === "split") node = node.first;
    return { ...node, content: null };
  };
  const project = (node: TileNode): TileNode | null => {
    const original = placed.get(node.id);
    if (node.kind === "tile") {
      const transient =
        !before.has(node.id) || (expandedBlank && node.id === reservation.before.id);
      if (
        transient &&
        original?.kind === "tile" &&
        contentKey(node.content) === contentKey(original.content)
      )
        return null;
      return node.content?.kind === "terminal" && node.content.session === reservation.id
        ? { ...node, content: null }
        : node;
    }
    const generated =
      !before.has(node.id) &&
      original?.kind === "split" &&
      node.direction === original.direction &&
      node.ratio === original.ratio;
    const first = project(node.first);
    const second = project(node.second);
    if (generated && (!first || !second)) return first ?? second;
    return { ...node, first: first ?? blank(node.first), second: second ?? blank(node.second) };
  };
  return project(tree) ?? blank(tree);
}
