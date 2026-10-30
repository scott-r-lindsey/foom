import { expect, test } from "vitest";
import { prepareMove, finishMove } from "../../../../src/renderer/board/move-placement";
import {
  initialLayout,
  leaves,
  placeContent,
  splitTile,
} from "../../../../src/renderer/board/tiles";

test("incoming terminal and preview placement is staged without an identity or tree mutation", () => {
  const base = initialLayout();
  for (const kind of ["terminal", "preview"] as const) {
    const staged = prepareMove(base, { tile: base.tree.id, zone: "center" }, { columns: 100 });
    expect(staged).not.toBeNull();
    if (!staged) throw new Error("placement");
    expect(leaves(base.tree)[0]?.content).toBeNull();
    const done = finishMove(staged, { kind, id: "real-id" });
    expect(leaves(done.tree)[0]?.content).toEqual(
      kind === "terminal" ? { kind, session: "real-id" } : { kind, preview: "real-id" },
    );
  }
});
test("default placement shares column growth and edge drops share split limits", () => {
  const base = initialLayout();
  const occupied = placeContent(base, { kind: "terminal", session: "existing" });
  if (!occupied) throw new Error("placement");
  const staged = prepareMove(occupied, null, { columns: 300 });
  expect(staged && leaves(staged.tree)).toHaveLength(2);
  for (const zone of ["left", "right", "up", "down"] as const) {
    const next = prepareMove(occupied, { tile: occupied.tree.id, zone }, { columns: 0 });
    expect(next && leaves(next.tree)).toHaveLength(2);
  }
  expect(prepareMove(occupied, { tile: "stale", zone: "left" }, { columns: 0 })).toBeNull();
  let deep = occupied;
  for (let i = 0; i < 64; i++) deep = splitTile(deep, "horizontal");
  expect(prepareMove(deep, { tile: deep.focused, zone: "right" }, { columns: 0 })).toBeNull();
  const done = staged && finishMove(staged, { kind: "preview", id: "p" });
  expect(done && leaves(done.tree).map((leaf) => leaf.content)).toEqual([
    { kind: "terminal", session: "existing" },
    { kind: "preview", preview: "p" },
  ]);
});

test("preview sidebar drops move their existing assignment and reuse edge geometry", async () => {
  const { dropTile } = await import("../../../../src/renderer/board/tiles");
  const base = placeContent(initialLayout(), { kind: "preview", preview: "p" });
  if (!base) throw new Error("placement");
  const split = splitTile(base, "horizontal");
  const target = split.landing ?? "";
  const placed = dropTile(split, { kind: "preview", id: "p" }, target, "center");
  expect(leaves(placed.tree).find((tile) => tile.id === target)?.content).toEqual({
    kind: "preview",
    preview: "p",
  });
  expect(leaves(placed.tree).filter((tile) => tile.content)).toHaveLength(1);
  const other = leaves(placed.tree).find((tile) => tile.id !== target);
  if (!other) throw new Error("other tile");
  const occupied = placeContent(
    { ...placed, focused: other.id },
    { kind: "terminal", session: "existing" },
    true,
  );
  if (!occupied) throw new Error("placement");
  const edge = dropTile(occupied, { kind: "preview", id: "p" }, other.id, "left");
  expect(leaves(edge.tree).filter((tile) => tile.content)).toHaveLength(2);
});
