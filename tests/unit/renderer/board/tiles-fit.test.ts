import { expect, test } from "vitest";
import {
  fitLayout,
  splitReason,
  dropReason,
  dropTile,
  growTile,
  MIN_TILE_COLUMNS,
  initialLayout,
  leaves,
  placeAgentPreview,
  placeSession,
  rectangles,
  resizeSplit,
  restoreLayout,
  splitTile,
  tidyTiles,
  evenSplitRun,
} from "../../../../src/renderer/board/tiles";
import type { TileLayout, TileMetrics, TileNode } from "../../../../src/renderer/board/tiles.d";

const metrics: TileMetrics = { width: 2400, height: 900, minWidth: 500, minHeight: 90 };
const leaf = (id: string, occupied = false): TileNode => ({
  kind: "tile",
  id,
  content: occupied ? { kind: "terminal", session: id } : null,
});
function nested(direction: "horizontal" | "vertical" = "horizontal"): TileLayout {
  return {
    focused: "a",
    landing: "space",
    maximized: null,
    tree: {
      kind: "split",
      id: "outer",
      direction,
      ratio: 0.5,
      first: {
        kind: "split",
        id: "inner",
        direction,
        ratio: 0.5,
        first: leaf("a", true),
        second: leaf("space"),
      },
      second: leaf("other"),
    },
  };
}
function usable(layout: TileLayout, size = metrics) {
  for (const { rect } of rectangles(layout.tree, { x: 0, y: 0, ...size }).tiles) {
    expect(rect.width).toBeGreaterThanOrEqual(size.minWidth - 0.01);
    expect(rect.height).toBeGreaterThanOrEqual(size.minHeight - 0.01);
  }
}
test.each(["horizontal", "vertical"] as const)(
  "pointer and keyboard commits repair nested %s spaces, preserving occupants",
  (axis) => {
    const size = axis === "horizontal" ? metrics : { ...metrics, height: 400 };
    const start = nested(axis);
    usable(start, size);
    for (const ratio of [0.15, 0.2, 0.85, 1]) {
      const next = fitLayout(resizeSplit(start, "outer", ratio, true), size);
      usable(next, size);
      expect(leaves(next.tree).find((tile) => tile.id === "a")).toBe(leaves(start.tree)[0]);
      expect(fitLayout(next, size)).toBe(next);
    }
  },
);
test("window/sidebar shrink, restore, evening, tidy and maximize restore share pixel repair", () => {
  const start = nested();
  const small = { ...metrics, width: 1100 };
  const saved = restoreLayout(JSON.stringify({ ...start, version: 2 }));
  for (const layout of [
    start,
    saved,
    evenSplitRun(start, "inner"),
    tidyTiles(start),
    { ...start, maximized: "a" },
  ]) {
    const next = fitLayout(layout, small);
    usable(next, small);
    expect(leaves(next.tree).some((tile) => tile.id === "space")).toBe(false);
    expect(leaves(next.tree).find((tile) => tile.id === "a")?.content).toEqual({
      kind: "terminal",
      session: "a",
    });
  }
  expect(fitLayout(start, metrics)).toBe(start);
});
test("placement prunes a tiny landing and uses visible space, or the full-board column rule", () => {
  const start = resizeSplit(nested(), "inner", 0.99);
  const next = placeSession(start, "new", false, { columns: 280, metrics });
  expect(next?.focused).toBe("other");
  expect(
    placeSession({ ...start, focused: "space" }, "new", true, { columns: 280, metrics })?.focused,
  ).toBe("other");
  expect(next && leaves(next.tree).some((tile) => tile.id === "space")).toBe(false);
  const preview = placeAgentPreview(start, "preview", { columns: 280, metrics });
  expect(preview.placement).toBe("empty");
  expect(preview.layout.focused).toBe("a");
  const withoutOther = fitLayout(start, { ...metrics, width: 900 });
  const column = placeSession(withoutOther, "new", false, { columns: 280, metrics });
  expect(column && leaves(column.tree).length).toBe(2);
  expect(column && leaves(column.tree).every((tile) => tile.content)).toBe(true);
});
test("infeasible layouts retain all occupants and remove spaces made too small by ratio fitting", () => {
  const start = nested();
  if (start.tree.kind !== "split" || start.tree.first.kind !== "split") throw new Error("fixture");
  const tree: TileNode = { ...start.tree, first: { ...start.tree.first, second: leaf("b", true) } };
  const next = fitLayout({ ...start, tree }, { ...metrics, width: 1000 });
  expect(leaves(next.tree).map((tile) => tile.id)).toEqual(["a", "b"]);
  usable(next, { ...metrics, width: 1000 });
  const crowded = fitLayout({ ...start, tree }, { ...metrics, width: 100 });
  expect(leaves(crowded.tree).map((tile) => tile.id)).toEqual(["a", "b"]);
  expect(rectangles(crowded.tree).tiles.map(({ rect }) => rect.width)).toEqual([50, 50]);
});
test("all-empty repairs retain one identity, clear stale focus/landing/maximize and tolerate unmeasured areas", () => {
  const empty = splitTile(initialLayout(), "horizontal");
  const next = fitLayout(
    { ...empty, focused: empty.focused, landing: empty.focused, maximized: "missing" },
    { ...metrics, width: 900 },
  );
  expect(leaves(next.tree)).toHaveLength(1);
  expect(next.focused).toBe(next.tree.id);
  expect(next.landing).toBeUndefined();
  expect(next.maximized).toBeNull();
  expect(fitLayout(next, { ...metrics, width: 1, height: 1 })).toBe(next);
  for (const value of [
    undefined,
    { ...metrics, width: 0 },
    { ...metrics, minHeight: NaN },
    { ...metrics, height: Infinity },
  ])
    expect(fitLayout(empty, value)).toBe(empty);
});

test("repair validates stale focus after a background placement restores an obsolete focus ID", () => {
  const start = nested();
  const placed = placeAgentPreview(start, "new", {
    columns: 280,
    metrics: { ...metrics, width: 1100 },
  });
  const fixed = fitLayout(
    { ...placed.layout, focused: "space", landing: "space", maximized: "missing" },
    { ...metrics, width: 1100 },
  );
  expect(fixed.focused).toBe("a");
  expect(fixed.landing).toBeUndefined();
  expect(fixed.maximized).toBeNull();
  expect(
    placeSession({ ...start, focused: "missing" }, "new", true, { columns: 280, metrics }),
  ).toBeNull();
});

test("pointer previews clamp nested occupants while retaining zero-size collapse previews until commit", () => {
  const start = nested();
  const dragging = fitLayout(resizeSplit(start, "outer", 0.15), metrics, false);
  expect(leaves(dragging.tree).map((tile) => tile.id)).toEqual(["a", "space", "other"]);
  const occupied = rectangles(dragging.tree, { x: 0, y: 0, ...metrics }).tiles.find(
    ({ tile }) => tile.id === "a",
  );
  expect(occupied?.rect.width).toBeGreaterThanOrEqual(metrics.minWidth - 0.01);
  expect(fitLayout(dragging, metrics).tree).not.toEqual(dragging.tree);
  const empty = splitTile(initialLayout(), "horizontal");
  const zero = resizeSplit(empty, empty.tree.id, 0);
  expect(fitLayout(zero, metrics, false)).toBe(zero);
  expect(leaves(fitLayout(zero, metrics).tree)).toHaveLength(1);
});

test.each(["left", "right", "up", "down", "horizontal", "vertical"] as const)(
  "measured %s splits agree with repair at the size boundary",
  (direction) => {
    const horizontal = direction === "left" || direction === "right" || direction === "horizontal";
    const start = placeSession(initialLayout(), "a");
    if (!start) throw new Error("fixture");
    for (const occupied of [true, false]) {
      const base = occupied ? start : initialLayout();
      for (const offset of [-1, 0, 1]) {
        const size = { width: 2 * 12 * 8, height: 2 * 90, minWidth: 12 * 8, minHeight: 90 };
        if (horizontal) size.width += offset;
        else size.height += offset;
        const candidate = splitTile(base, direction);
        const repaired = fitLayout(candidate, size);
        const survives = leaves(repaired.tree).length === 2;
        expect(survives).toBe(offset >= 0);
        expect(splitReason(base, direction, size)).toBe(
          survives ? undefined : horizontal ? "Too narrow to split" : "Too short to split",
        );
        const next = splitTile(base, direction, size);
        if (survives) expect(leaves(fitLayout(next, size).tree)).toHaveLength(2);
        else expect(next).toBe(base);
      }
    }
  },
);

test("splits use unmaximized nested geometry and refuse a perpendicular shortage", () => {
  const size = { width: 240, height: 180, minWidth: 96, minHeight: 90 };
  const pair = splitTile(initialLayout(), "right");
  expect(splitReason({ ...pair, maximized: pair.focused }, "left", size)).toBe(
    "Too narrow to split",
  );
  expect(splitReason(pair, "up", size)).toBeUndefined();
  const short = { ...size, height: 80 };
  expect(splitReason(pair, "left", short)).toBe("Too narrow to split");
  const wide = { ...short, width: 800 };
  expect(splitReason(pair, "left", wide)).toBeUndefined();
  expect(splitReason(pair, "down", wide)).toBe("Too short to split");
});

test("edge drops refuse atomically, but whole-leaf moves test the space freed at their origin", () => {
  const start = placeSession(initialLayout(), "a");
  if (!start) throw new Error("fixture");
  const small = { width: 190, height: 180, minWidth: 96, minHeight: 90 };
  const drag = { kind: "session" as const, id: "b" };
  expect(dropReason(start, drag, start.focused, "right", small)).toBe("Too narrow to split");
  expect(dropTile(start, drag, start.focused, "right", small)).toBe(start);
  expect(dropReason(start, drag, start.focused, "center", small)).toBeUndefined();
  const pair = splitTile(start, "left");
  const space = leaves(pair.tree).find((tile) => !tile.content);
  if (!space) throw new Error("fixture");
  const occupied = placeSession({ ...pair, focused: space.id }, "b", true);
  if (!occupied) throw new Error("fixture");
  const move = { kind: "tile" as const, id: space.id };
  const size = { ...small, width: 200 };
  expect(dropReason(occupied, move, start.focused, "left", size)).toBeUndefined();
  const next = dropTile(occupied, move, start.focused, "left", size);
  expect(leaves(next.tree)).toHaveLength(2);
  expect(growTile(pair, "right").tree).toEqual(start.tree);
});

test("automatic columns share the small manual floor and only replace below it", () => {
  const start = placeSession(initialLayout(), "a");
  if (!start) throw new Error("fixture");
  for (const columns of [MIN_TILE_COLUMNS * 2 - 1, MIN_TILE_COLUMNS * 2, 100]) {
    const next = placeSession(start, "b", false, { columns });
    expect(next && leaves(next.tree)).toHaveLength(columns < MIN_TILE_COLUMNS * 2 ? 1 : 2);
  }
});

test("saved spaces allowed by the old width minimum keep their identities and ratios", () => {
  const start = nested();
  const saved = restoreLayout(JSON.stringify({ version: 2, ...start }));
  expect(fitLayout(saved, { ...metrics, minWidth: 12 * 8 })).toBe(saved);
});
