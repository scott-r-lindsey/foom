import type { TileLayout, TileLeaf, TileNode, TilePreset, TileRect, TileSplit } from "./tiles.d";
const id = () => crypto.randomUUID();
export const newTile = (): TileLeaf => ({ kind: "tile", id: id(), session: null });
export const initialLayout = (): TileLayout => {
  const tree = newTile();
  return { tree, focused: tree.id, maximized: null };
};
export function leaves(tree: TileNode): TileLeaf[] {
  return tree.kind === "tile" ? [tree] : [...leaves(tree.first), ...leaves(tree.second)];
}
export const clampRatio = (ratio: number) =>
  Number.isFinite(ratio) ? Math.max(0.15, Math.min(0.85, ratio)) : 0.5;
function update(tree: TileNode, target: string, fn: (node: TileNode) => TileNode): TileNode {
  if (tree.id === target) return fn(tree);
  return tree.kind === "tile"
    ? tree
    : { ...tree, first: update(tree.first, target, fn), second: update(tree.second, target, fn) };
}
function split(
  first: TileNode,
  second: TileNode,
  direction: TileSplit["direction"],
  ratio = 0.5,
): TileSplit {
  return { kind: "split", id: id(), direction, ratio, first, second };
}
export function splitTile(layout: TileLayout, direction: TileSplit["direction"]): TileLayout {
  const depth = (node: TileNode, level = 0): number =>
    node.id === layout.focused
      ? level
      : node.kind === "tile"
        ? -1
        : Math.max(depth(node.first, level + 1), depth(node.second, level + 1));
  const targetDepth = depth(layout.tree);
  // Keep every constructible tree within the persisted format's resource bounds.
  if (targetDepth < 0 || targetDepth >= 64 || leaves(layout.tree).length >= 256) return layout;
  const next = newTile();
  return {
    ...layout,
    maximized: null,
    tree: update(layout.tree, layout.focused, (node) => split(node, next, direction)),
    focused: next.id,
  };
}
export function closeTile(layout: TileLayout): TileLayout {
  let focused = layout.focused;
  const remove = (node: TileNode): TileNode | null => {
    if (node.id === layout.focused) return null;
    if (node.kind === "tile") return node;
    const first = remove(node.first),
      second = remove(node.second);
    if (first && second) return { ...node, first, second };
    const sibling = first ?? second;
    if (sibling) focused = leaves(sibling)[0]?.id ?? sibling.id;
    return sibling;
  };
  const remaining = remove(layout.tree);
  const tree = remaining ?? newTile();
  return { tree, focused: remaining ? focused : tree.id, maximized: null };
}
export function hideSession(layout: TileLayout): TileLayout {
  return {
    ...layout,
    tree: update(layout.tree, layout.focused, (node) =>
      node.kind === "tile" ? { ...node, session: null } : node,
    ),
  };
}
export function resizeSplit(layout: TileLayout, target: string, ratio: number): TileLayout {
  return {
    ...layout,
    tree: update(layout.tree, target, (node) =>
      node.kind === "split" ? { ...node, ratio: clampRatio(ratio) } : node,
    ),
  };
}
export function placeSession(
  layout: TileLayout,
  session: string,
  replace = false,
): TileLayout | null {
  const tiles = leaves(layout.tree);
  const visible = tiles.find((tile) => tile.session === session);
  const focused = tiles.find((tile) => tile.id === layout.focused);
  const target = replace
    ? focused
    : (visible ??
      (focused?.session === null ? focused : tiles.find((tile) => tile.session === null)));
  if (!target) return null;
  let tree = layout.tree;
  if (replace && visible && visible.id !== target.id)
    tree = update(tree, visible.id, (node) => ({ ...node, session: null }));
  tree = update(tree, target.id, (node) => ({ ...node, session }));
  return { ...layout, tree, focused: target.id, maximized: layout.maximized ? target.id : null };
}
export function preset(layout: TileLayout, kind: TilePreset): TileLayout {
  const old = leaves(layout.tree);
  const ordered = [
    ...old.filter((tile) => tile.id === layout.focused && tile.session !== null),
    ...old.filter((tile) => tile.id !== layout.focused && tile.session !== null),
    ...old.filter((tile) => tile.id === layout.focused && tile.session === null),
    ...old.filter((tile) => tile.id !== layout.focused && tile.session === null),
  ];
  const take = () => ordered.shift() ?? newTile();
  const a = take();
  const tree =
    kind === "one"
      ? a
      : kind === "columns"
        ? split(a, take(), "horizontal")
        : kind === "rows"
          ? split(a, take(), "vertical")
          : kind === "grid"
            ? split(split(a, take(), "vertical"), split(take(), take(), "vertical"), "horizontal")
            : kind === "main2"
              ? split(a, split(take(), take(), "vertical"), "horizontal", 0.6)
              : split(
                  a,
                  split(take(), split(take(), take(), "vertical"), "vertical", 1 / 3),
                  "horizontal",
                  0.6,
                );
  return { tree, focused: a.id, maximized: null };
}
/** Flat rectangles let React keep each leaf under the same parent across tree edits. */
export function rectangles(
  tree: TileNode,
  area: TileRect = { x: 0, y: 0, width: 100, height: 100 },
): {
  tiles: { tile: TileLeaf; rect: TileRect }[];
  gutters: { split: TileSplit; rect: TileRect; area: TileRect }[];
} {
  if (tree.kind === "tile") return { tiles: [{ tile: tree, rect: area }], gutters: [] };
  const horizontal = tree.direction === "horizontal";
  const first = {
    ...area,
    width: horizontal ? area.width * tree.ratio : area.width,
    height: horizontal ? area.height : area.height * tree.ratio,
  };
  const second = {
    x: horizontal ? area.x + first.width : area.x,
    y: horizontal ? area.y : area.y + first.height,
    width: area.width - (horizontal ? first.width : 0),
    height: area.height - (horizontal ? 0 : first.height),
  };
  const a = rectangles(tree.first, first),
    b = rectangles(tree.second, second);
  return {
    tiles: [...a.tiles, ...b.tiles],
    gutters: [
      {
        split: tree,
        area,
        rect: {
          ...area,
          x: horizontal ? second.x : area.x,
          y: horizontal ? area.y : second.y,
          width: horizontal ? 0 : area.width,
          height: horizontal ? area.height : 0,
        },
      },
      ...a.gutters,
      ...b.gutters,
    ],
  };
}
export function neighbor(layout: TileLayout, direction: "left" | "right" | "up" | "down"): string {
  const tiles = rectangles(layout.tree).tiles;
  const current = tiles.find((item) => item.tile.id === layout.focused);
  if (!current) return layout.focused;
  const cx = current.rect.x + current.rect.width / 2,
    cy = current.rect.y + current.rect.height / 2;
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  return (
    tiles
      .filter((item) => item !== current)
      .map((item) => {
        const dx = item.rect.x + item.rect.width / 2 - cx,
          dy = item.rect.y + item.rect.height / 2 - cy;
        return {
          id: item.tile.id,
          forward: (horizontal ? dx : dy) * sign,
          distance: Math.abs(horizontal ? dy : dx) * 2 + Math.abs(horizontal ? dx : dy),
        };
      })
      .filter((item) => item.forward > 0)
      .sort((a, b) => a.distance - b.distance)[0]?.id ?? layout.focused
  );
}
export const TILE_STORAGE = "foom.tiles.v1";
/** Bounded, fail-closed parsing: persisted layout metadata never grants capabilities. */
export function restoreLayout(raw: string | null): TileLayout {
  try {
    if (!raw || raw.length > 100000) return initialLayout();
    const value: unknown = JSON.parse(raw);
    const ids = new Set<string>(),
      sessions = new Set<string>();
    let count = 0;
    const parse = (node: unknown, depth: number): TileNode => {
      if (
        !node ||
        typeof node !== "object" ||
        !("kind" in node) ||
        !("id" in node) ||
        typeof node.id !== "string" ||
        !node.id ||
        node.id.length > 200 ||
        ids.has(node.id) ||
        depth > 64 ||
        ++count > 511
      )
        throw new Error("Invalid tile");
      ids.add(node.id);
      if (
        node.kind === "tile" &&
        "session" in node &&
        (node.session === null ||
          (typeof node.session === "string" &&
            node.session.length > 0 &&
            node.session.length <= 200 &&
            !sessions.has(node.session)))
      ) {
        if (node.session) sessions.add(node.session);
        return { kind: "tile", id: node.id, session: node.session };
      }
      if (
        node.kind !== "split" ||
        !("direction" in node) ||
        (node.direction !== "horizontal" && node.direction !== "vertical") ||
        !("ratio" in node) ||
        typeof node.ratio !== "number" ||
        !Number.isFinite(node.ratio) ||
        !("first" in node) ||
        !("second" in node)
      )
        throw new Error("Invalid split");
      return {
        kind: "split",
        id: node.id,
        direction: node.direction,
        ratio: clampRatio(node.ratio),
        first: parse(node.first, depth + 1),
        second: parse(node.second, depth + 1),
      };
    };
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("tree" in value)
    )
      return initialLayout();
    const tree = parse(value.tree, 0),
      tiles = leaves(tree);
    const focused =
      "focused" in value &&
      typeof value.focused === "string" &&
      tiles.some((tile) => tile.id === value.focused)
        ? value.focused
        : (tiles[0]?.id ?? tree.id);
    return { tree, focused, maximized: null };
  } catch {
    return initialLayout();
  }
}
export function pruneSessions(layout: TileLayout, sessions: ReadonlySet<string>): TileLayout {
  const prune = (node: TileNode): TileNode =>
    node.kind === "tile"
      ? node.session && !sessions.has(node.session)
        ? { ...node, session: null }
        : node
      : { ...node, first: prune(node.first), second: prune(node.second) };
  return { ...layout, tree: prune(layout.tree) };
}
export function saveLayout(storage: Pick<Storage, "setItem">, layout: TileLayout): void {
  storage.setItem(
    TILE_STORAGE,
    JSON.stringify({ version: 1, tree: layout.tree, focused: layout.focused }),
  );
}
