import type { TileContent, TileLayout, TileNode, TileStartupReservation } from "./tiles.d";

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

/** Splitting a reserved tile explicitly adopts its surrounding layout. */
export function splitsStartupTile(
  before: TileNode,
  after: TileNode,
  reservations: readonly TileStartupReservation[],
): boolean {
  if (!reservations.length) return false;
  const previous = index(before);
  const anchors = new Set(
    reservations.flatMap((entry) =>
      [...index(entry.placed).values()].flatMap((node) =>
        node.kind === "tile" &&
        node.content?.kind === "terminal" &&
        node.content.session === entry.id
          ? [node.id]
          : [],
      ),
    ),
  );
  return [...index(after).values()].some(
    (node) =>
      node.kind === "split" &&
      !previous.has(node.id) &&
      ((node.first.kind === "tile" &&
        anchors.has(node.first.id) &&
        node.second.kind === "tile" &&
        node.second.content === null) ||
        (node.second.kind === "tile" &&
          anchors.has(node.second.id) &&
          node.first.kind === "tile" &&
          node.first.content === null)),
  );
}

/** Remove a presentation, retaining edits made after its placement. */
export function settledStartupTree(
  tree: TileNode,
  reservation: TileStartupReservation,
  preserveGeometry = false,
): TileNode {
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
        !preserveGeometry &&
        transient &&
        original?.kind === "tile" &&
        (contentKey(node.content) === contentKey(original.content) ||
          (node.content === null &&
            original.content?.kind === "terminal" &&
            original.content.session === reservation.id))
      )
        return null;
      return node.content?.kind === "terminal" && node.content.session === reservation.id
        ? { ...node, content: null }
        : node;
    }
    const generated =
      !preserveGeometry &&
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

export function projectStartupLayout(
  layout: TileLayout,
  reservations: readonly TileStartupReservation[],
): TileLayout {
  if (!reservations.length) return layout;
  const preserve = reservations.some(
    (entry) => entry.preserveGeometry ?? splitsStartupTile(entry.placed, layout.tree, [entry]),
  );
  let tree = layout.tree;
  for (const entry of [...reservations].reverse()) tree = settledStartupTree(tree, entry, preserve);
  const tiles = [...index(tree).values()].filter((node) => node.kind === "tile");
  return {
    ...layout,
    tree,
    focused: tiles.some((tile) => tile.id === layout.focused)
      ? layout.focused
      : (tiles[0]?.id ?? tree.id),
    landing: tiles.some((tile) => tile.id === layout.landing && tile.content === null)
      ? layout.landing
      : undefined,
    maximized: tiles.some((tile) => tile.id === layout.maximized) ? layout.maximized : null,
  };
}
