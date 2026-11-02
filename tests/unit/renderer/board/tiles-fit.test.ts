import { expect, test } from "vitest";
import {
  fitLayout,
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
