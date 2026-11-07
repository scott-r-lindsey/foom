import { expect, test } from "vitest";
import { prepareMove } from "../../../../src/renderer/board/move-placement";
import {
  dropReason,
  dropTile,
  fitLayout,
  leaves,
  rectangles,
} from "../../../../src/renderer/board/tiles";
import type {
  TileContent,
  TileLayout,
  TileLeaf,
  TileMetrics,
  TileNode,
  TileSplit,
} from "../../../../src/renderer/board/tiles.d";

const pane = (id: string, content: TileContent = { kind: "terminal", session: id }): TileLeaf => ({
  kind: "tile",
  id,
  content,
});
const pair = (
  first: TileNode,
  second: TileNode,
  direction: TileSplit["direction"],
  ratio: number,
): TileSplit => ({
  kind: "split",
  id: `${first.id}-${second.id}`,
  direction,
  ratio,
  first,
  second,
});
const board = (tree: TileNode): TileLayout => ({ tree, focused: "a", maximized: null });
const size: TileMetrics = { width: 1200, height: 900, minWidth: 96, minHeight: 88 };
const dimensions = (layout: TileLayout, metrics = size) =>
  rectangles(layout.tree, { x: 0, y: 0, ...metrics }).tiles.map(({ tile, rect }) => ({
    id: tile.id,
    width: rect.width,
    height: rect.height,
  }));

test.each([
  { axis: "vertical", ratio: 160 / 900, zone: "down", lengths: [88, 88, 724] },
  { axis: "horizontal", ratio: 150 / 1200, zone: "right", lengths: [96, 96, 1008] },
] as const)(
  "occupied $axis edge drops rebalance neighboring room before checking the floor",
  ({ axis, ratio, zone, lengths }) => {
    const start = board(pair(pane("a"), pane("b"), axis, ratio));
    const drag = { kind: "session", id: "s" } as const;
    expect(dropReason(start, drag, "a", zone, size)).toBeUndefined();
    expect(dropReason(start, undefined, "a", zone, size)).toBeUndefined();
    const next = fitLayout(dropTile(start, drag, "a", zone, size), size);
    expect(leaves(next.tree).map((tile) => tile.content)).toEqual([
      { kind: "terminal", session: "a" },
      { kind: "terminal", session: "s" },
      { kind: "terminal", session: "b" },
    ]);
    dimensions(next).forEach((rect, index) => {
      expect(axis === "horizontal" ? rect.width : rect.height).toBeCloseTo(lengths[index] ?? 0);
    });
    const staged = prepareMove(start, { tile: "a", zone }, { columns: 150, metrics: size });
    expect(staged).not.toBeNull();
    if (!staged) throw new Error("Missing staged drop");
    dimensions(staged).forEach((rect, index) => {
      expect(axis === "horizontal" ? rect.width : rect.height).toBeCloseTo(lengths[index] ?? 0);
    });
  },
);

test("a whole-tile move from A / [B / C] rebalances its occupied landing", () => {
  const start = board(
    pair(pane("a"), pair(pane("b"), pane("c"), "vertical", 0.5), "vertical", 160 / 900),
  );
  const drag = { kind: "tile", id: "c" } as const;
  expect(dropReason(start, drag, "a", "down", size)).toBeUndefined();
  const next = fitLayout(dropTile(start, drag, "a", "down", size), size);
  expect(dimensions(next).map((rect) => rect.id)).toEqual(["a", "c", "b"]);
  dimensions(next).forEach((rect, index) => {
    expect(rect.height).toBeCloseTo([88, 88, 724][index] ?? 0);
  });
});

test.each(["session", "preview"] as const)(
  "%s sidebar moves of A to B's right match title-bar moves on a 250px board",
  (kind) => {
    const content: TileContent =
      kind === "session" ? { kind: "terminal", session: "a" } : { kind: "preview", preview: "a" };
    const start = board(pair(pane("a", content), pane("b"), "horizontal", 0.5));
    const metrics = { ...size, width: 250, height: 400, minWidth: 100 };
    const sidebar = { kind, id: "a" };
    const title = { kind: "tile", id: "a" } as const;
    expect(dropReason(start, sidebar, "b", "right", metrics)).toBeUndefined();
    expect(dropReason(start, title, "b", "right", metrics)).toBeUndefined();
    const moved = fitLayout(dropTile(start, sidebar, "b", "right", metrics), metrics);
    const dragged = fitLayout(dropTile(start, title, "b", "right", metrics), metrics);
    const geometry = (layout: TileLayout) =>
      dimensions(layout, metrics).map(({ width, height }) => ({ width, height }));
    expect(geometry(moved)).toEqual(geometry(dragged));
    expect(dimensions(moved, metrics).map(({ width }) => width)).toEqual([125, 125]);
    expect(leaves(moved.tree).map((tile) => tile.content)).toEqual([
      { kind: "terminal", session: "b" },
      content,
    ]);
  },
);

test.each(["left", "right", "up", "down"] as const)(
  "a title-bar drop on its own %s edge is a no-op without refusal",
  (zone) => {
    const start = board(pair(pane("a"), pane("b"), "horizontal", 0.5));
    const metrics = { ...size, width: 2000 };
    const drag = { kind: "tile", id: "a" } as const;
    expect(dropReason(start, drag, "a", zone, metrics)).toBeUndefined();
    expect(dropTile(start, drag, "a", zone, metrics)).toBe(start);
  },
);

test("an occupied edge drop still refuses a genuinely insufficient height atomically", () => {
  const start = board(pane("a"));
  const metrics = { ...size, height: 160 };
  const drag = { kind: "session", id: "s" } as const;
  expect(dropReason(start, drag, "a", "down", metrics)).toBe("Too short to split");
  expect(dropTile(start, drag, "a", "down", metrics)).toBe(start);
  expect(prepareMove(start, { tile: "a", zone: "down" }, { columns: 150, metrics })).toBeNull();
});

test("visible sidebar origins share title-bar resource limits", () => {
  let tree: TileNode = pair(pane("a"), pane("b"), "vertical", 0.5);
  for (let index = 0; index < 63; index++)
    tree = pair(tree, pane(`sibling-${String(index)}`), "vertical", 0.5);
  const start = board(tree);
  for (const drag of [
    { kind: "session", id: "b" },
    { kind: "tile", id: "b" },
  ] as const) {
    expect(dropReason(start, drag, "a", "down")).toBeUndefined();
    expect(leaves(dropTile(start, drag, "a", "down").tree)).toHaveLength(65);
  }
});
