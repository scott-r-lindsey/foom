import { expect, test } from "vitest";
import {
  initialLayout,
  leaves,
  splitTile,
  closeTile,
  hideSession,
  clampRatio,
  resizeSplit,
  placeSession,
  preset,
  rectangles,
  neighbor,
  restoreLayout,
  pruneSessions,
  saveLayout,
} from "../../../../src/renderer/board/tiles";
import type { TileLayout, TileNode, TilePreset } from "../../../../src/renderer/board/tiles.d";
function place(layout: TileLayout, session: string, replace = false) {
  const next = placeSession(layout, session, replace);
  if (!next) throw new Error("No space");
  return next;
}
test("arbitrary nested splits retain leaf identity; closing gives the sibling the space", () => {
  const start = place(initialLayout(), "a"),
    original = leaves(start.tree)[0];
  const right = splitTile(start, "horizontal");
  const filled = place(right, "b");
  const down = splitTile(filled, "vertical");
  expect(leaves(down.tree).map((tile) => tile.session)).toEqual(["a", "b", null]);
  expect(leaves(down.tree)[0]).toBe(original);
  expect(rectangles(down.tree).tiles.map((item) => item.rect)).toEqual([
    { x: 0, y: 0, width: 50, height: 100 },
    { x: 50, y: 0, width: 50, height: 50 },
    { x: 50, y: 50, width: 50, height: 50 },
  ]);
  const closed = closeTile(down);
  expect(leaves(closed.tree)).toEqual(leaves(filled.tree));
  expect(closed.focused).toBe(filled.focused);
  const single = closeTile({ ...closed, focused: original?.id ?? "" });
  expect(leaves(single.tree).map((tile) => tile.session)).toEqual(["b"]);
  const last = closeTile(single);
  expect(leaves(last.tree).map((tile) => tile.session)).toEqual([null]);
  expect(last.focused).toBe(last.tree.id);
  expect(last.maximized).toBeNull();
});
test("gutters clamp finite ratios and leave leaves untouched", () => {
  expect([-0.1, 0.2, 2, NaN, Infinity].map(clampRatio)).toEqual([0.15, 0.2, 0.85, 0.5, 0.5]);
  const start = splitTile(initialLayout(), "vertical");
  expect(resizeSplit(start, start.focused, 0.7)).toEqual(start);
  const resized = resizeSplit(start, start.tree.id, 2);
  expect(resized.tree).toMatchObject({ ratio: 0.85 });
  expect(rectangles(resized.tree).gutters[0]?.rect.y).toBe(85);
});
test("placing focuses visible sessions, uses focused empty then first empty, refuses full, and explicit replace moves once", () => {
  let layout = preset(initialLayout(), "main2");
  const ids = leaves(layout.tree).map((tile) => tile.id);
  layout = place({ ...layout, focused: ids[1] ?? "" }, "a");
  expect(layout.focused).toBe(ids[1]);
  layout = place(layout, "b");
  expect(layout.focused).toBe(ids[0]);
  layout = place(layout, "c");
  expect(layout.focused).toBe(ids[2]);
  expect(placeSession(layout, "d")).toBeNull();
  layout = place({ ...layout, maximized: layout.focused }, "b");
  expect(layout.focused).toBe(ids[0]);
  expect(layout.maximized).toBe(ids[0]);
  layout = place(layout, "a", true);
  expect(leaves(layout.tree).map((tile) => tile.session)).toEqual(["a", null, "c"]);
  layout = hideSession(layout);
  expect(leaves(layout.tree).map((tile) => tile.session)).toEqual([null, null, "c"]);
  expect(placeSession({ ...layout, focused: "missing" }, "d", true)).toBeNull();
});
test.each<[TilePreset, number]>([
  ["one", 1],
  ["columns", 2],
  ["rows", 2],
  ["grid", 4],
  ["main2", 3],
  ["main3", 4],
])("%s is a tree shortcut preserving the focused leaf first", (key, count) => {
  let layout = preset(initialLayout(), "grid");
  for (const session of ["a", "b", "c", "d"]) layout = place(layout, session);
  const focused = leaves(layout.tree).find((tile) => tile.id === layout.focused);
  const next = preset({ ...layout, maximized: layout.focused }, key);
  expect(leaves(next.tree)).toHaveLength(count);
  expect(leaves(next.tree)[0]).toBe(focused);
  expect(next.maximized).toBeNull();
  expect(new Set(leaves(next.tree).map((tile) => tile.id)).size).toBe(count);
});
test("presets reuse empty identities, add empty slots and directional focus follows geometry", () => {
  const start = initialLayout();
  const layout = preset(start, "grid");
  const ids = leaves(layout.tree).map((tile) => tile.id);
  expect(ids[0]).toBe(start.focused);
  expect(neighbor(layout, "right")).toBe(ids[2]);
  expect(neighbor(layout, "down")).toBe(ids[1]);
  expect(neighbor(layout, "up")).toBe(ids[0]);
  expect(neighbor({ ...layout, focused: ids[3] ?? "" }, "left")).toBe(ids[1]);
  expect(neighbor({ ...layout, focused: "unknown" }, "left")).toBe("unknown");
  expect(leaves(preset(layout, "grid").tree)).toEqual(leaves(layout.tree));
});
test("persistence restores ratios and identities but clears maximize and removes vanished sessions after inventory arrives", () => {
  let layout = place(splitTile(initialLayout(), "horizontal"), "a");
  layout = place(layout, "b");
  let saved = "";
  saveLayout(
    {
      setItem: (_key, raw) => {
        saved = raw;
      },
    },
    { ...layout, maximized: layout.focused },
  );
  expect(restoreLayout(saved)).toEqual(layout);
  expect(leaves(pruneSessions(layout, new Set(["a"])).tree).map((tile) => tile.session)).toEqual([
    null,
    "a",
  ]);
  const withEmpty = hideSession(layout);
  expect(pruneSessions(withEmpty, new Set(["a"]))).toEqual(withEmpty);
  expect(() => {
    saveLayout(
      {
        setItem: () => {
          throw new Error("quota");
        },
      },
      layout,
    );
  }).toThrow("quota");
});
test("restore validates untrusted storage, including duplicate identities and sessions and bounded trees", () => {
  const leaf = { kind: "tile", id: "a", session: null };
  const root = {
    kind: "split",
    id: "root",
    direction: "horizontal",
    ratio: 2,
    first: leaf,
    second: { ...leaf, id: "b", session: "s" },
  };
  expect(
    restoreLayout(JSON.stringify({ version: 1, tree: root, focused: "missing" })),
  ).toMatchObject({ focused: "a", tree: { ratio: 0.85 } });
  const malformed: unknown[] = [
    null,
    [],
    {},
    { kind: "tile", id: "" },
    { ...leaf, id: 3 },
    { ...leaf, id: "a".repeat(201) },
    { ...leaf, session: 2 },
    { ...leaf, session: "" },
    { ...leaf, session: "s".repeat(201) },
    { ...root, direction: "bad" },
    { ...root, ratio: "1" },
    { ...root, first: leaf, second: leaf },
    { ...root, first: { ...leaf, session: "s" } },
    { ...root, second: undefined },
    { ...root, kind: "unknown" },
  ];
  for (const tree of malformed)
    expect(leaves(restoreLayout(JSON.stringify({ version: 1, tree })).tree)).toHaveLength(1);
  for (const raw of [
    null,
    "bad",
    "null",
    "{}",
    JSON.stringify({ version: 2, tree: leaf }),
    "x".repeat(100001),
  ])
    expect(leaves(restoreLayout(raw).tree)[0]?.session).toBeNull();
  let deep: TileNode = { kind: "tile", id: "leaf", session: null };
  for (let i = 0; i < 66; i++)
    deep = {
      kind: "split",
      id: `s${String(i)}`,
      direction: "vertical",
      ratio: 0.5,
      first: deep,
      second: { kind: "tile", id: `l${String(i)}`, session: null },
    };
  expect(restoreLayout(JSON.stringify({ version: 1, tree: deep })).tree.kind).toBe("tile");
});

test("shrinking a preset preserves an occupied session even when focus is empty", () => {
  const filled = place(initialLayout(), "kept");
  const layout = splitTile(filled, "horizontal");
  const single = preset(layout, "one");
  expect(leaves(single.tree).map((tile) => tile.session)).toEqual(["kept"]);
  expect(single.focused).toBe(filled.focused);
});

test("split construction stays within restore bounds and ignores an absent focus", () => {
  let layout = initialLayout();
  expect(splitTile({ ...layout, focused: "absent" }, "horizontal").focused).toBe("absent");
  for (let index = 0; index < 64; index++) layout = splitTile(layout, "vertical");
  expect(splitTile(layout, "horizontal")).toBe(layout);
  expect(restoreLayout(JSON.stringify({ version: 1, ...layout }))).toEqual(layout);
  let wide = initialLayout();
  for (let round = 0; round < 8; round++) {
    for (const tile of leaves(wide.tree))
      wide = splitTile({ ...wide, focused: tile.id }, "horizontal");
  }
  expect(leaves(wide.tree)).toHaveLength(256);
  expect(splitTile(wide, "vertical")).toBe(wide);
});

test("closing a nested tile focuses the first leaf of its replacement sibling", () => {
  const layout = preset(initialLayout(), "main3");
  const tiles = leaves(layout.tree);
  for (const [closed, focused] of [
    [3, 2],
    [2, 3],
    [1, 2],
    [0, 1],
  ]) {
    const target = tiles[closed ?? -1];
    const sibling = tiles[focused ?? -1];
    if (!target || !sibling) throw new Error("Missing tile");
    const next = closeTile({ ...layout, focused: target.id, maximized: target.id });
    expect(next.focused).toBe(sibling.id);
    expect(next.maximized).toBeNull();
    expect(leaves(next.tree)).not.toContain(target);
  }
});
