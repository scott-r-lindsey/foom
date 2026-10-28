import { arrangedLayout } from "../../../fixtures/tile-layout";
import { expect, test } from "vitest";
import {
  placeAgentPreview,
  blankColumns,
  evenSplitRun,
  tidyTiles,
  growTile,
  growTarget,
  terminals,
  landingSpace,
  dropTile,
  swapTiles,
  dropZone,
  initialLayout,
  leaves,
  splitTile,
  closeTile,
  closeSpace,
  hideSession,
  clampRatio,
  resizeSplit,
  placeSession,
  rectangles,
  neighbor,
  restoreLayout,
  pruneContent,
  sessionId,
  placeContent,
  contentId,
  saveLayout,
} from "../../../../src/renderer/board/tiles";
import type { TileLayout, TileNode } from "../../../../src/renderer/board/tiles.d";
function place(layout: TileLayout, session: string, replace = false) {
  const next = placeSession(layout, session, replace);
  if (!next) throw new Error("No space");
  return next;
}
test("hide and close retain geometry and identity and make the space the landing spot", () => {
  let layout = place(initialLayout(), "a");
  layout = place(splitTile(layout, "horizontal"), "b");
  layout = place(splitTile(layout, "vertical"), "c");
  const geometry = rectangles(layout.tree).tiles.map((item) => item.rect);
  for (const hide of [hideSession, closeTile]) {
    const next = hide(layout);
    expect(rectangles(next.tree).tiles.map((item) => item.rect)).toEqual(geometry);
    expect(leaves(next.tree).map((tile) => tile.id)).toEqual(
      leaves(layout.tree).map((tile) => tile.id),
    );
    expect(landingSpace(next)?.id).toBe(layout.focused);
    expect(place(next, "d").focused).toBe(layout.focused);
    expect(next.maximized).toBeNull();
  }
  const empty = closeTile(place(initialLayout(), "only"));
  expect(empty.tree).toMatchObject({ content: null });
  expect(empty.focused).toBe(empty.tree.id);
});
test("gutters clamp finite ratios and leave leaves untouched", () => {
  expect([-0.1, 0.2, 2, NaN, Infinity].map(clampRatio)).toEqual([0.15, 0.2, 0.85, 0.5, 0.5]);
  const start = place(splitTile(place(initialLayout(), "a"), "vertical"), "b");
  expect(resizeSplit(start, start.focused, 0.7)).toEqual(start);
  const resized = resizeSplit(start, start.tree.id, 2);
  expect(resized.tree).toMatchObject({ ratio: 0.85 });
  expect(rectangles(resized.tree).gutters[0]?.rect.y).toBe(85);
});
test("placing focuses visible sessions, uses landing then first empty, replaces the oldest eligible when full, and explicit replace moves once", () => {
  let layout = arrangedLayout(initialLayout(), "main2");
  const ids = leaves(layout.tree).map((tile) => tile.id);
  layout = place({ ...layout, focused: ids[1] ?? "", landing: ids[1] ?? "" }, "a");
  expect(layout.focused).toBe(ids[1]);
  layout = place(layout, "b");
  expect(layout.focused).toBe(ids[0]);
  layout = place(layout, "c");
  expect(layout.focused).toBe(ids[2]);
  expect(leaves(place(layout, "d").tree).map((tile) => sessionId(tile) ?? null)).toEqual([
    "d",
    "a",
    "c",
  ]);
  layout = place({ ...layout, maximized: layout.focused }, "b");
  expect(layout.focused).toBe(ids[0]);
  expect(layout.maximized).toBe(ids[0]);
  layout = place(layout, "a", true);
  expect(leaves(layout.tree).map((tile) => sessionId(tile) ?? null)).toEqual(["a", null, "c"]);
  layout = hideSession(layout);
  expect(leaves(layout.tree).map((tile) => sessionId(tile) ?? null)).toEqual([null, null, "c"]);
  expect(placeSession({ ...layout, focused: "missing" }, "d", true)).toBeNull();
});
test("directional focus follows split geometry", () => {
  let layout = arrangedLayout(initialLayout(), "grid");
  for (const session of ["a", "b", "c", "d"]) layout = place(layout, session);
  const ids = leaves(layout.tree).map((tile) => tile.id);
  layout = { ...layout, focused: ids[0] ?? "" };
  expect(neighbor(layout, "right")).toBe(ids[2]);
  expect(neighbor(layout, "down")).toBe(ids[1]);
  expect(neighbor(layout, "up")).toBe(ids[0]);
  expect(neighbor({ ...layout, focused: ids[3] ?? "" }, "left")).toBe(ids[1]);
  expect(neighbor({ ...layout, focused: "unknown" }, "left")).toBe("unknown");
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
  expect(
    leaves(pruneContent(layout, { sessions: new Set(["a"]), previews: new Set() }).tree).map(
      (tile) => sessionId(tile) ?? null,
    ),
  ).toEqual([null, "a"]);
  const withEmpty = hideSession(layout);
  expect(pruneContent(withEmpty, { sessions: new Set(["a"]), previews: new Set() })).toEqual(
    withEmpty,
  );
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
  ).toMatchObject({ focused: "b", tree: { ratio: 0.85 } });
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
    expect(leaves(restoreLayout(raw).tree)[0]?.content).toBeNull();
  let deep: TileNode = { kind: "tile", id: "leaf", content: null };
  for (let i = 0; i < 66; i++)
    deep = {
      kind: "split",
      id: `s${String(i)}`,
      direction: "vertical",
      ratio: 0.5,
      first: deep,
      second: { kind: "tile", id: `l${String(i)}`, content: null },
    };
  expect(restoreLayout(JSON.stringify({ version: 1, tree: deep })).tree.kind).toBe("tile");
});

test("split construction stays within restore bounds and ignores an absent focus", () => {
  let layout = initialLayout();
  expect(splitTile({ ...layout, focused: "absent" }, "horizontal").focused).toBe("absent");
  for (let index = 0; index < 64; index++) layout = splitTile(layout, "vertical");
  expect(splitTile(layout, "horizontal")).toBe(layout);
  expect(restoreLayout(JSON.stringify({ version: 2, ...layout }))).toEqual(layout);
  let wide = initialLayout();
  for (let round = 0; round < 8; round++) {
    for (const tile of leaves(wide.tree))
      wide = splitTile({ ...wide, focused: tile.id }, "horizontal");
  }
  expect(leaves(wide.tree)).toHaveLength(256);
  expect(splitTile(wide, "vertical")).toBe(wide);
});

test.each(["left", "right", "up", "down"] as const)(
  "session drop splits %s and visible sessions move only once",
  (zone) => {
    const start = place(initialLayout(), "a");
    const next = dropTile(start, { kind: "session", id: "b" }, start.focused, zone);
    const sessions = leaves(next.tree).map((tile) => sessionId(tile) ?? null);
    expect(sessions).toEqual(zone === "left" || zone === "up" ? ["b", "a"] : ["a", "b"]);
    expect(next.tree).toMatchObject({
      direction: zone === "left" || zone === "right" ? "horizontal" : "vertical",
      ratio: 0.5,
    });
    const again = dropTile(next, { kind: "session", id: "b" }, start.focused, zone);
    expect(leaves(again.tree).filter((tile) => (sessionId(tile) ?? null) === "b")).toHaveLength(1);
    expect(leaves(again.tree).filter((tile) => tile.content === null)).toHaveLength(1);
  },
);
test("center drops replace sessions, swap identities, and reject vanished or self targets", () => {
  const start = place(initialLayout(), "a");
  const next = dropTile(start, { kind: "session", id: "b" }, start.focused, "center");
  expect(leaves(next.tree).map((tile) => sessionId(tile) ?? null)).toEqual(["b"]);
  const pair = place(splitTile(start, "horizontal"), "b");
  const swapped = dropTile(pair, { kind: "tile", id: start.focused }, pair.focused, "center");
  expect(leaves(swapped.tree)).toEqual(leaves(pair.tree).reverse());
  expect(swapped.focused).toBe(start.focused);
  for (const [from, to] of [
    ["absent", pair.focused],
    [pair.focused, "absent"],
    [pair.focused, pair.focused],
  ]) {
    expect(swapTiles(pair, from ?? "", to ?? "")).toBe(pair);
    expect(dropTile(pair, { kind: "tile", id: from ?? "" }, to ?? "", "left")).toBe(pair);
  }
});
test.each(["left", "right", "up", "down"] as const)(
  "tile move %s collapses the old parent and keeps every leaf",
  (zone) => {
    let start = arrangedLayout(initialLayout(), "main3");
    for (const session of ["a", "b", "c", "d"]) start = place(start, session);
    const original = leaves(start.tree);
    const from = original[2],
      to = original[0];
    if (!from || !to) throw new Error("fixture");
    const moved = dropTile(start, { kind: "tile", id: from.id }, to.id, zone);
    expect(new Set(leaves(moved.tree))).toEqual(new Set(original));
    expect(moved.focused).toBe(from.id);
    expect(restoreLayout(JSON.stringify({ version: 2, ...moved }))).toEqual(moved);
  },
);
test("a depth-limited drop is atomic, including moving an existing tile", () => {
  let layout = place(initialLayout(), "a");
  for (let i = 0; i < 64; i++) layout = splitTile(layout, "vertical");
  expect(dropTile(layout, { kind: "session", id: "new" }, layout.focused, "down")).toBe(layout);
  const outer = splitTile(
    { ...layout, focused: leaves(layout.tree).at(-1)?.id ?? "" },
    "horizontal",
  );
  expect(dropTile(outer, { kind: "tile", id: outer.landing ?? "" }, layout.focused, "down")).toBe(
    outer,
  );
});
test("drop zones choose the nearest edge with an unambiguous center", () => {
  expect(
    [
      [0.5, 0.5],
      [0.1, 0.5],
      [0.9, 0.5],
      [0.5, 0.1],
      [0.5, 0.9],
    ].map(([x, y]) => dropZone(x ?? 0, y ?? 0)),
  ).toEqual(["center", "left", "right", "up", "down"]);
});

test("split retains focus and placement chooses the newest space; empty drops fill it", () => {
  const start = place(initialLayout(), "a");
  const first = splitTile(start, "horizontal");
  const next = splitTile(first, "vertical");
  expect(next.focused).toBe(start.focused);
  expect(landingSpace(next)?.id).toBe(next.landing);
  const filled = place(next, "b");
  expect(filled.focused).toBe(next.landing);
  expect(terminals(filled.tree).map((tile) => sessionId(tile) ?? null)).toEqual(["a", "b"]);
  const space = landingSpace(filled);
  if (!space) throw new Error("No space");
  const dropped = dropTile(filled, { kind: "session", id: "c" }, space.id, "left");
  expect(leaves(dropped.tree)).toHaveLength(3);
  expect(dropped.focused).toBe(space.id);
  expect(terminals(dropped.tree)).toHaveLength(3);
});
test.each(["left", "up", "right", "down"] as const)(
  "split and grow %s preserve focus and content",
  (direction) => {
    const start = place(initialLayout(), "a");
    const next = splitTile(start, direction);
    expect(next.focused).toBe(start.focused);
    expect(next.tree.kind).toBe("split");
    if (next.tree.kind !== "split") throw new Error("Expected split");
    const first = direction === "left" || direction === "up";
    expect(next.tree.direction).toBe(
      direction === "left" || direction === "right" ? "horizontal" : "vertical",
    );
    expect((first ? next.tree.first : next.tree.second).id).toBe(next.landing);
    expect(growTile(next, direction).tree).toEqual(start.tree);
    const occupied = place(next, "b");
    const target = { ...occupied, focused: start.focused };
    const reason = { left: "to the left", right: "to the right", up: "above", down: "below" };
    expect(growTarget(target, direction)).toEqual({ reason: `Occupied tile ${reason[direction]}` });
    expect(growTile(target, direction)).toBe(target);
    const edge = { left: "left", right: "right", up: "top", down: "bottom" };
    expect(growTarget(start, direction)).toEqual({ reason: `At the ${edge[direction]} edge` });
    expect(growTile(start, direction)).toBe(start);
    expect(growTarget({ ...start, focused: "stale" }, direction)).toEqual({
      reason: `At the ${edge[direction]} edge`,
    });
  },
);
test.each(["left", "up", "right", "down"] as const)(
  "grow %s skips the wrong side in mixed-axis trees",
  (direction) => {
    const opposite = { left: "right", right: "left", up: "down", down: "up" } as const;
    const axis = direction === "left" || direction === "right" ? "down" : "right";
    const start = place(initialLayout(), "a");
    const outer = splitTile(start, direction);
    const mixed = splitTile(outer, axis);
    const inner = splitTile(mixed, opposite[direction]);
    // Nearest same-axis split is occupied on the wrong side; the empty outer side is usable.
    const filled = place(inner, "b");
    const target = { ...filled, focused: start.focused };
    const result = growTile(target, direction);
    expect(leaves(result.tree)).toHaveLength(3);
    expect(terminals(result.tree).map(sessionId)).toEqual(terminals(target.tree).map(sessionId));
    expect(result.focused).toBe(start.focused);
    const occupiedOuter = placeSession({ ...target, focused: outer.landing ?? "" }, "c", true);
    if (!occupiedOuter) throw new Error("Expected placement");
    expect(growTile({ ...occupiedOuter, focused: start.focused }, direction).tree).toEqual(
      occupiedOuter.tree,
    );
  },
);
test("close space removes only empty leaves and preserves the focused terminal", () => {
  const start = place(initialLayout(), "a");
  const next = splitTile(start, "left");
  expect(closeSpace(next, next.landing ?? "")).toMatchObject({
    tree: start.tree,
    focused: start.focused,
  });
  expect(closeSpace(next, start.focused)).toBe(next);
  expect(closeSpace(next, "stale")).toBe(next);
  const empty = initialLayout();
  const closed = closeSpace(empty, empty.focused);
  expect(leaves(closed.tree)).toHaveLength(1);
  expect(terminals(closed.tree)).toHaveLength(0);
});

test("gutter preview and commit collapse only all-space sides and preserve occupied limits", () => {
  const left = splitTile(place(initialLayout(), "a"), "horizontal");
  const preview = resizeSplit(left, left.tree.id, 0.95);
  expect(leaves(preview.tree)).toHaveLength(2);
  expect(preview.tree).toMatchObject({ ratio: 0.95 });
  expect(resizeSplit(preview, left.tree.id, 0.95, true).tree).toEqual(leaves(left.tree)[0]);
  const right = place(splitTile(initialLayout(), "vertical"), "a");
  expect(resizeSplit(right, right.tree.id, 0.07, true).tree).toEqual(leaves(right.tree)[1]);
  expect(leaves(resizeSplit(right, right.tree.id, 0.08, true).tree)).toHaveLength(2);
  const occupied = place(left, "b");
  expect(resizeSplit(occupied, occupied.tree.id, 1, true).tree).toMatchObject({ ratio: 0.85 });
  expect(resizeSplit(occupied, occupied.tree.id, -1, true).tree).toMatchObject({ ratio: 0.15 });
  expect(resizeSplit(left, left.tree.id, NaN).tree).toMatchObject({ ratio: 0.5 });
  expect(resizeSplit(left, "stale", 0, true)).toEqual(left);
});

test("placement and center drops preserve narrow space; swaps restore gutter minimums", () => {
  const pair = splitTile(place(initialLayout(), "a"), "horizontal");
  const narrow = resizeSplit(pair, pair.tree.id, 0.9);
  expect(place(narrow, "b").tree).toMatchObject({ ratio: 0.9 });
  const empty = landingSpace(narrow);
  if (!empty) throw new Error("No space");
  expect(dropTile(narrow, { kind: "session", id: "b" }, empty.id, "center").tree).toMatchObject({
    ratio: 0.9,
  });
  const swapped = swapTiles(narrow, narrow.focused, empty.id);
  expect(swapped.tree).toMatchObject({ ratio: 0.85 });
  const leftSpace = place(splitTile(initialLayout(), "horizontal"), "a");
  const squeezed = resizeSplit(leftSpace, leftSpace.tree.id, 0.1);
  expect(place(squeezed, "b").tree).toMatchObject({ ratio: 0.1 });
});

test("full columns scale proportionally and preserve nested rows", () => {
  let layout = arrangedLayout(initialLayout(), "main3");
  for (const session of ["a", "b", "c", "d"]) layout = place(layout, session);
  const before = rectangles(layout.tree).tiles;
  const next = placeSession(layout, "new", false, { columns: 400 });
  if (!next) throw new Error("Missing layout");
  const after = rectangles(next.tree).tiles;
  before.forEach((item, index) => {
    expect(after[index]?.rect.width).toBeCloseTo((item.rect.width * 2) / 3);
    expect(after[index]?.rect.height).toBe(item.rect.height);
    expect(after[index]?.rect.y).toBe(item.rect.y);
    expect(after[index]?.tile).toBe(item.tile);
  });
  expect(after.at(-1)?.rect.width).toBeCloseTo(100 / 3);
  expect(after.at(-1)?.rect.x).toBeCloseTo(200 / 3);
});
test("a vertical root becomes the left half of a new two-column root", () => {
  let layout = arrangedLayout(initialLayout(), "rows");
  layout = place(place(layout, "a"), "b");
  expect(placeSession(layout, "c", false, { columns: 180 })?.tree).toMatchObject({
    direction: "horizontal",
    ratio: 0.5,
    first: layout.tree,
    second: { content: { kind: "terminal", session: "c" } },
  });
});
test("minimum width uses LRU, protects focus and attention, and falls back to focused non-attention", () => {
  let layout = arrangedLayout(initialLayout(), "grid");
  for (const session of ["a", "b", "c", "d"]) layout = place(layout, session);
  const ids = leaves(layout.tree).map((tile) => tile.id);
  const focusedAt = new Map(ids.map((id, index) => [id, [3, 1, 2, 4][index] ?? 0]));
  const options = { columns: 100, focusedAt, needsYou: new Set(["b"]) };
  const next = placeSession(layout, "new", false, options);
  expect(next && leaves(next.tree).map((tile) => sessionId(tile) ?? null)).toEqual([
    "a",
    "b",
    "new",
    "d",
  ]);
  const fallback = placeSession(layout, "new", false, {
    ...options,
    needsYou: new Set(["a", "b", "c"]),
  });
  expect(fallback?.focused).toBe(layout.focused);
  const protectedAll = placeSession(layout, "new", false, {
    ...options,
    needsYou: new Set(["a", "b", "c", "d"]),
  });
  expect(protectedAll && leaves(protectedAll.tree)).toHaveLength(5);
});
test("blank widths produce 1–3 equal columns, but arranged layouts are not re-split", () => {
  expect([0, 99, 199, 200, 299, 300, 450, NaN, Infinity].map(blankColumns)).toEqual([
    1, 1, 1, 2, 2, 3, 3, 1, 1,
  ]);
  const start = initialLayout();
  const next = placeSession(start, "a", false, { columns: 400 });
  if (!next) throw new Error("Missing layout");
  expect(leaves(next.tree).map((tile) => sessionId(tile) ?? null)).toEqual(["a", null, null]);
  rectangles(next.tree).tiles.forEach((item) => {
    expect(item.rect.width).toBeCloseTo(100 / 3);
  });
  expect(placeSession(next, "b", false, { columns: 400 })?.focused).toBe(leaves(next.tree)[1]?.id);
  const arranged = splitTile(start, "vertical");
  expect(placeSession(arranged, "a", false, { columns: 400 })?.tree).toMatchObject({
    direction: "vertical",
  });
});
test("column growth preserves automatic ratios on focus and persistence", () => {
  let layout = place(initialLayout(), "a");
  for (let index = 0; index < 8; index++) {
    const next = placeSession(layout, String(index), false, { columns: 1000 });
    if (!next) throw new Error("Missing layout");
    layout = next;
  }
  const hidden = hideSession(layout);
  expect(placeSession(hidden, "7")?.tree).toEqual(layout.tree);
  const focused = placeSession(layout, "a");
  expect(focused?.tree).toEqual(layout.tree);
  expect(restoreLayout(JSON.stringify({ version: 2, ...layout })).tree).toEqual(layout.tree);
});

const leaf = (id: string, session: string | null = id): TileNode => ({
  kind: "tile",
  id,
  content: session === null ? null : { kind: "terminal", session },
});
const branch = (
  id: string,
  direction: "horizontal" | "vertical",
  first: TileNode,
  second: TileNode,
  ratio = 0.2,
): TileNode => ({ kind: "split", id, direction, first, second, ratio });
test.each(["horizontal", "vertical"] as const)(
  "evening a %s run crosses both same-axis branches but stops at perpendicular splits",
  (axis) => {
    const other = axis === "horizontal" ? "vertical" : "horizontal";
    const nested = branch("nested", other, leaf("c"), leaf("d"), 0.7);
    const run = branch(
      "run",
      axis,
      branch("left", axis, leaf("a"), leaf("b")),
      branch("right", axis, nested, leaf("e")),
    );
    const outside = branch("outside", axis, leaf("f"), leaf("g"), 0.8);
    const layout = {
      tree: branch("root", other, run, outside, 0.6),
      focused: "d",
      maximized: null,
    };
    for (const target of ["run", "left", "right"]) {
      const next = evenSplitRun(layout, target);
      expect(next.tree).toMatchObject({
        ratio: 0.6,
        first: { ratio: 0.5, first: { ratio: 0.5 }, second: { ratio: 0.5, first: nested } },
        second: outside,
      });
      expect(leaves(next.tree)).toEqual(leaves(layout.tree));
      leaves(next.tree).forEach((tile, i) => {
        expect(tile).toBe(leaves(layout.tree)[i]);
      });
      expect(next.focused).toBe("d");
    }
    expect(evenSplitRun(layout, "missing")).toBe(layout);
    expect(evenSplitRun(layout, "a")).toBe(layout);
  },
);
test.each(["horizontal", "vertical"] as const)(
  "evening a %s run weights a nested row block by its widest row",
  (axis) => {
    const other = axis === "horizontal" ? "vertical" : "horizontal";
    const row = (id: string, count: number): TileNode => {
      let tree = leaf(`${id}-1`);
      for (let i = 2; i <= count; i++)
        tree = branch(
          `${id}-split-${String(i)}`,
          axis,
          tree,
          leaf(`${id}-${String(i)}`),
          (i - 1) / i,
        );
      return tree;
    };
    for (const [top, bottom] of [
      [3, 3],
      [1, 3],
      [3, 1],
    ] as const) {
      const block = branch("block", other, row("top", top), row("bottom", bottom), 0.7);
      const single = branch("single", other, leaf("c4-top"), leaf("c4-bottom"), 0.4);
      const layout: TileLayout = {
        tree: branch(
          "root",
          axis,
          branch("inner", axis, block, single, 0.758),
          leaf("agent"),
          0.715,
        ),
        focused: "agent",
        maximized: null,
      };
      for (const target of ["root", "inner"]) {
        const next = evenSplitRun(layout, target);
        expect(next.tree).toMatchObject({
          ratio: 4 / 5,
          first: { ratio: 3 / 4, first: block, second: single },
        });
        for (const { tile, rect } of rectangles(next.tree).tiles) {
          const size = axis === "horizontal" ? rect.width : rect.height;
          const count = tile.id.startsWith("top-")
            ? top
            : tile.id.startsWith("bottom-")
              ? bottom
              : 3;
          expect(size).toBeCloseTo(60 / count);
        }
        expect(evenSplitRun(next, target)).toEqual(next);
      }
      const tidied = tidyTiles(layout);
      expect(tidied.tree).toMatchObject({
        ratio: 4 / 5,
        first: { ratio: 3 / 4, first: { ratio: 0.5 }, second: { ratio: 0.5 } },
      });
      expect(leaves(tidied.tree)).toEqual(leaves(layout.tree));
      expect(tidyTiles(tidied)).toEqual(tidied);
      for (const { split } of rectangles(tidied.tree).gutters)
        expect(evenSplitRun(tidied, split.id)).toEqual(tidied);
    }
  },
);
test("long runs use equal shares beyond 15–85 percent and persist them", () => {
  let tree = leaf("0");
  for (let i = 1; i < 10; i++) tree = branch(`s${String(i)}`, "horizontal", tree, leaf(String(i)));
  const next = evenSplitRun({ tree, focused: "0", maximized: null }, tree.id);
  expect(next.tree).toMatchObject({ ratio: 0.9 });
  for (const { rect } of rectangles(next.tree).tiles) expect(rect.width).toBeCloseTo(10);
  expect(restoreLayout(JSON.stringify({ version: 2, ...next }))).toEqual(next);
  const pair = {
    tree: branch("pair", "vertical", leaf("a"), leaf("b")),
    focused: "a",
    maximized: null,
  };
  expect(evenSplitRun(pair, "pair").tree).toMatchObject({ ratio: 0.5 });
});
test("tidy removes spaces, collapses parents before joining runs, and preserves occupied identities and focus", () => {
  const nested = branch("stack", "vertical", leaf("c"), leaf("d"), 0.8);
  const joined = branch("joined", "horizontal", leaf("b"), nested);
  const tree = branch(
    "root",
    "horizontal",
    branch("hole", "vertical", leaf("empty", null), leaf("a")),
    branch("collapse", "vertical", joined, leaf("empty2", null)),
  );
  const next = tidyTiles({ tree, focused: "d", maximized: "d", landing: "empty" });
  expect(next).toMatchObject({
    focused: "d",
    maximized: null,
    tree: {
      ratio: 1 / 3,
      first: { id: "a" },
      second: { id: "joined", ratio: 0.5, second: { ratio: 0.5 } },
    },
  });
  expect(next.landing).toBeUndefined();
  const old = terminals(tree);
  leaves(next.tree).forEach((tile, i) => {
    expect(tile).toBe(old[i]);
  });
  expect(tidyTiles(next)).toEqual(next);
  expect(tidyTiles({ tree, focused: "empty", maximized: null }).focused).toBe("a");
});
test("tidy retains one existing empty leaf, preferring focus, and leaves a single terminal alone", () => {
  const empty = branch(
    "root",
    "vertical",
    leaf("a", null),
    branch("inner", "horizontal", leaf("b", null), leaf("c", null)),
  );
  expect(tidyTiles({ tree: empty, focused: "b", maximized: null })).toEqual({
    tree: leaf("b", null),
    focused: "b",
    maximized: null,
  });
  expect(tidyTiles({ tree: empty, focused: "missing", maximized: null })).toEqual({
    tree: leaf("a", null),
    focused: "a",
    maximized: null,
  });
  const single = { tree: leaf("a"), focused: "a", maximized: null };
  expect(tidyTiles(single)).toEqual(single);
});

test("mixed content keeps occupancy, numbering and identities across tile operations", () => {
  const start = place(splitTile(place(initialLayout(), "s"), "horizontal"), "other");
  const mixed = placeContent(start, { kind: "preview", preview: "p" }, true);
  if (!mixed) throw new Error("Missing mixed layout");
  const tiles = terminals(mixed.tree);
  expect(tiles.map((tile) => contentId(tile.content))).toEqual(["s", "p"]);
  expect(sessionId(tiles[1])).toBeUndefined();
  expect(neighbor({ ...mixed, focused: tiles[0]?.id ?? "" }, "right")).toBe(tiles[1]?.id);
  expect(growTarget(mixed, "left")).toEqual({ reason: "Occupied tile to the left" });
  const swapped = swapTiles(mixed, tiles[0]?.id ?? "", tiles[1]?.id ?? "");
  expect(terminals(swapped.tree).map((tile) => contentId(tile.content))).toEqual(["p", "s"]);
  const dropped = dropTile(mixed, { kind: "tile", id: mixed.focused }, tiles[0]?.id ?? "", "down");
  expect(terminals(dropped.tree).map((tile) => contentId(tile.content))).toEqual(["s", "p"]);
  expect(terminals(tidyTiles(splitTile(mixed, "vertical")).tree)).toEqual(tiles);
  const pruned = pruneContent(mixed, { sessions: new Set(["s"]), previews: new Set() });
  expect(leaves(pruned.tree).map((tile) => tile.content)).toEqual([
    { kind: "terminal", session: "s" },
    null,
  ]);
  expect(pruned.focused).toBe(tiles[0]?.id);
  expect(pruneContent(mixed, { sessions: new Set(["s"]), previews: new Set(["p"]) })).toEqual(
    mixed,
  );
  let saved = "";
  saveLayout(
    {
      setItem: (_key, raw) => {
        saved = raw;
      },
    },
    mixed,
  );
  expect(JSON.parse(saved)).toMatchObject({ version: 2 });
  expect(restoreLayout(saved)).toEqual(mixed);
});
test("v1 migrates unchanged and invalid v2 preview content becomes space", () => {
  const migrated = restoreLayout(
    JSON.stringify({
      version: 1,
      tree: { kind: "tile", id: "tile", session: "s" },
      focused: "tile",
    }),
  );
  expect(migrated.tree).toEqual({
    kind: "tile",
    id: "tile",
    content: { kind: "terminal", session: "s" },
  });
  for (const content of [
    null,
    {},
    { kind: "preview", preview: "" },
    { kind: "preview", preview: 1 },
    { kind: "preview", preview: "p".repeat(201) },
    { kind: "other", preview: "p" },
  ]) {
    expect(
      restoreLayout(JSON.stringify({ version: 2, tree: { kind: "tile", id: "tile", content } }))
        .tree,
    ).toEqual({ kind: "tile", id: "tile", content: null });
  }
  const duplicate = restoreLayout(
    JSON.stringify({
      version: 2,
      tree: {
        kind: "split",
        id: "root",
        direction: "horizontal",
        ratio: 0.5,
        first: { kind: "tile", id: "a", content: { kind: "preview", preview: "p" } },
        second: { kind: "tile", id: "b", content: { kind: "preview", preview: "p" } },
      },
    }),
  );
  expect(leaves(duplicate.tree).map((tile) => tile.content)).toEqual([
    { kind: "preview", preview: "p" },
    null,
  ]);
});

test("closing inventory content leaves its space as the next arrival's landing spot", () => {
  const first = placeSession(initialLayout(), "parent");
  if (!first) throw new Error("Missing layout");
  const second = placeSession(splitTile(first, "horizontal"), "child");
  if (!second) throw new Error("Missing child");
  const childTile = leaves(second.tree).find(
    (tile) => tile.content?.kind === "terminal" && tile.content.session === "child",
  );
  const pruned = pruneContent(second, { sessions: new Set(["parent"]), previews: new Set() });
  expect(pruned.landing).toBe(childTile?.id);
  const arrival = placeSession(pruned, "next");
  expect(
    leaves(arrival?.tree ?? pruned.tree).find((tile) => tile.id === childTile?.id)?.content,
  ).toEqual({ kind: "terminal", session: "next" });
});

test("agent previews fill landing then tree-order empties without altering focus or geometry", () => {
  const layout = arrangedLayout(initialLayout(), "grid");
  const tiles = leaves(layout.tree);
  const start = {
    ...layout,
    landing: tiles[2]?.id ?? "missing",
    focused: tiles[1]?.id ?? "",
    maximized: tiles[1]?.id ?? "",
  };
  const first = placeAgentPreview(start, "a");
  expect(first.placement).toBe("landing");
  expect(first.layout.focused).toBe(start.focused);
  expect(first.layout.maximized).toBe(start.maximized);
  expect(rectangles(first.layout.tree).tiles.map(({ rect }) => rect)).toEqual(
    rectangles(start.tree).tiles.map(({ rect }) => rect),
  );
  expect(leaves(first.layout.tree)[2]?.content).toEqual({ kind: "preview", preview: "a" });
  let next = placeAgentPreview(first.layout, "b");
  expect(next.placement).toBe("empty");
  expect(leaves(next.layout.tree)[0]?.content).toEqual({ kind: "preview", preview: "b" });
  for (const id of ["c", "d"]) next = placeAgentPreview(next.layout, id);
  const full = placeAgentPreview(next.layout, "e", { columns: 600 });
  expect(full.placement).toBe("column");
  expect(full.layout.focused).toBe(start.focused);
  expect(full.layout.maximized).toBe(start.maximized);
  expect(leaves(full.layout.tree).at(-1)?.content).toEqual({ kind: "preview", preview: "e" });
  expect(placeAgentPreview(full.layout, "e")).toEqual({
    layout: full.layout,
    placement: "existing",
  });
  expect(placeAgentPreview(initialLayout(), "only").placement).toBe("empty");
});

test("agent previews use terminal overflow geometry and narrow fallback without replacing focus", () => {
  const arranged = arrangedLayout(initialLayout(), "grid");
  let full = arranged;
  for (const id of ["a", "b", "c", "d"]) full = placeAgentPreview(full, id).layout;
  for (const columns of [600, 80]) {
    const options = { columns, preserveFocus: true };
    const expected = placeContent(full, { kind: "preview", preview: "new" }, false, options);
    const placed = placeAgentPreview(full, "new", options);
    expect(placed.placement).toBe(columns === 600 ? "column" : "replace");
    expect(placed.layout.focused).toBe(full.focused);
    expect(leaves(placed.layout.tree).find((tile) => tile.id === full.focused)?.content).toEqual(
      leaves(full.tree).find((tile) => tile.id === full.focused)?.content,
    );
    expect(rectangles(placed.layout.tree).tiles.map(({ rect }) => rect)).toEqual(
      expected && rectangles(expected.tree).tiles.map(({ rect }) => rect),
    );
  }
  let limited = full;
  while (leaves(limited.tree).length < 256) {
    const next = splitTile(limited, "horizontal");
    if (next.tree === limited.tree) break;
    const landing = next.landing;
    if (!landing) throw new Error("Missing landing");
    limited = { ...placeAgentPreview(next, landing).layout, focused: landing };
  }
  const needsYou = new Set<string>();
  const terminalTree = (node: TileNode): TileNode =>
    node.kind === "tile"
      ? { ...node, content: { kind: "terminal", session: node.id } }
      : { ...node, first: terminalTree(node.first), second: terminalTree(node.second) };
  limited = { ...limited, tree: terminalTree(limited.tree) };
  for (const tile of leaves(limited.tree)) needsYou.add(tile.id);
  expect(placeAgentPreview(limited, "overflow", { columns: 0, needsYou })).toEqual({
    layout: limited,
    placement: "sidebar",
  });
});

test("sidebar width persists per window and untrusted values fall back to the default", () => {
  const values = new Map<string, string>();
  const storage = {
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const layout = { ...initialLayout(), sidebarWidth: 480, sidebarCollapsed: true };
  saveLayout(storage, layout, "window-one");
  expect(restoreLayout(values.get("window-one") ?? null)).toEqual(layout);
  expect(restoreLayout(values.get("window-two") ?? null).sidebarWidth).toBeUndefined();
  for (const sidebarWidth of [null, "300", -1, 239, 10001]) {
    expect(
      restoreLayout(JSON.stringify({ version: 2, ...layout, sidebarWidth })).sidebarWidth,
    ).toBeUndefined();
  }
});

test.each([100, 200, 300])("all content shares blank-window geometry at %i cells", (columns) => {
  const start = initialLayout();
  const terminal = placeSession(start, "terminal", false, { columns });
  const child = placeSession(start, "child", false, { columns, preserveFocus: true });
  const preview = placeAgentPreview(start, "preview", { columns }).layout;
  const manual = placeAgentPreview(start, "manual", { columns }).layout;
  const reopened = placeContent(start, { kind: "preview", preview: "sidebar" }, false, { columns });
  if (!terminal || !child || !reopened) throw new Error("Missing placement");
  const geometry = (layout: TileLayout) => rectangles(layout.tree).tiles.map(({ rect }) => rect);
  expect(leaves(terminal.tree)).toHaveLength(columns / 100);
  for (const layout of [terminal, child, preview, manual, reopened]) {
    expect(geometry(layout)).toEqual(geometry(terminal));
    expect(leaves(layout.tree)[0]?.content).not.toBeNull();
    expect(
      leaves(layout.tree)
        .slice(1)
        .every((tile) => tile.content === null),
    ).toBe(true);
    expect(layout.focused).toBe(start.focused);
  }
});

test("placement uses tree-order space rather than a focused empty tile without a landing", () => {
  const start = arrangedLayout(initialLayout(), "grid");
  const tiles = leaves(start.tree);
  const layout = { ...start, focused: tiles[3]?.id ?? "missing" };
  const next = placeSession(layout, "terminal");
  expect(leaves(next?.tree ?? start.tree)[0]?.content).toEqual({
    kind: "terminal",
    session: "terminal",
  });
  expect(leaves(placeAgentPreview(layout, "preview").layout.tree)[0]?.content).toEqual({
    kind: "preview",
    preview: "preview",
  });
});

test.each(["terminal", "child", "preview", "manual", "sidebar"] as const)(
  "%s keeps arranged trees and shares landing, empty, growth and replacement placement",
  (kind) => {
    const placeKind = (layout: TileLayout, columns: number) => {
      const options = {
        columns,
        preserveFocus: kind === "child" || kind === "preview" || kind === "manual",
      };
      const next =
        kind === "terminal" || kind === "child"
          ? placeSession(layout, "arrival", false, options)
          : kind === "sidebar"
            ? placeContent(layout, { kind: "preview", preview: "arrival" }, false, options)
            : placeAgentPreview(layout, "arrival", options).layout;
      if (!next) throw new Error("Missing placement");
      return next;
    };
    const arranged = arrangedLayout(initialLayout(), "grid");
    const tiles = leaves(arranged.tree);
    const start = { ...arranged, landing: tiles[2]?.id ?? "missing" };
    const landed = placeKind(start, 1000);
    expect(leaves(landed.tree).find((tile) => tile.content)?.id).toBe(start.landing);
    expect(rectangles(landed.tree).tiles.map(({ rect }) => rect)).toEqual(
      rectangles(start.tree).tiles.map(({ rect }) => rect),
    );
    expect(leaves(placeKind(arranged, 1000).tree).find((tile) => tile.content)?.id).toBe(
      tiles[0]?.id,
    );
    let full = arranged;
    for (const session of ["a", "b", "c", "d"]) full = place(full, session);
    const grown = placeKind(full, 1000);
    expect(leaves(grown.tree)).toHaveLength(5);
    expect(contentId(leaves(grown.tree).at(-1)?.content)).toBe("arrival");
    const replaced = placeKind(full, 80);
    expect(leaves(replaced.tree)).toHaveLength(4);
    expect(contentId(leaves(replaced.tree)[0]?.content)).toBe("arrival");
    expect(leaves(replaced.tree).at(-1)?.content).toEqual(leaves(full.tree).at(-1)?.content);
  },
);
