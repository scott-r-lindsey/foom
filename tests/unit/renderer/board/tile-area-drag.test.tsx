// @vitest-environment jsdom
import { act, fireEvent } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { TILE_STORAGE } from "../../../../src/renderer/board/tiles";
import { registerTileAreaFixture, setup } from "./tile-area-fixture";

registerTileAreaFixture();

test("title drags and keyboard swaps keep controllers attached; Escape and outside drags cannot change layout", async () => {
  const { screen, click, send, views, row } = setup();
  click(0);
  send("split-right");
  click(1);
  await act(async () => {});
  const tiles = [...screen.container.querySelectorAll<HTMLElement>(".terminal-tile")];
  const a = tiles[0],
    b = tiles[1];
  if (!a || !b) throw new Error("tiles");
  const counts = () =>
    views.map((view) => [
      view.open.mock.calls.length,
      view.hide.mock.calls.length,
      view.mount.mock.calls.length,
    ]);
  const before = counts();
  vi.spyOn(a, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    right: 100,
    bottom: 100,
    toJSON: () => ({}),
  });
  vi.spyOn(b, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    right: 100,
    bottom: 100,
    toJSON: () => ({}),
  });
  const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  const drag = (source: Element, target: Element, x = 50, y = 50) => {
    fireEvent.dragStart(source, { dataTransfer: transfer });
    fireEvent.dragOver(target, { dataTransfer: transfer, clientX: x, clientY: y });
    fireEvent.drop(target, { dataTransfer: transfer, clientX: x, clientY: y });
    fireEvent.dragEnd(source);
  };
  // jsdom does not implement DragEvent coordinates.
  vi.stubGlobal("DragEvent", MouseEvent);
  drag(a.querySelector("header") ?? a, b);
  expect([...screen.container.querySelectorAll(".terminal-tile")]).toEqual([b, a]);
  send("swap-left");
  expect([...screen.container.querySelectorAll(".terminal-tile")]).toEqual([a, b]);
  send("swap-right");
  send("swap-up");
  send("swap-down");
  drag(a.querySelector("header") ?? a, b, 50, 90);
  expect(counts()).toEqual(before);
  const saved = localStorage.getItem(TILE_STORAGE);
  const focusCounts = () => views.map((view) => view.focus.mock.calls.length);
  const beforeCancel = focusCounts();
  fireEvent.dragStart(row(2), { dataTransfer: transfer });
  fireEvent.dragOver(b, { dataTransfer: transfer, clientX: 50, clientY: 50 });
  expect(screen.container.querySelector(".tile-drop-preview")?.textContent).toBe("Replace session");
  fireEvent.keyDown(b, { key: "Escape" });
  fireEvent.drop(b, { dataTransfer: transfer, clientX: 50, clientY: 50 });
  expect(localStorage.getItem(TILE_STORAGE)).toBe(saved);
  expect(focusCounts()).toEqual(beforeCancel);
  drag(row(2), b);
  expect(document.activeElement).toBe(b);
  expect(views[1]?.open).toHaveBeenLastCalledWith("check");
  drag(row(3), b, 10, 50);
  expect(screen.container.querySelectorAll(".terminal-tile")).toHaveLength(3);
  expect(document.activeElement).toBe(
    screen.container.querySelector('.terminal-tile[data-focused="true"]'),
  );
  expect(views[2]?.focus).toHaveBeenCalledOnce();
  const beforeNoop = focusCounts();
  drag(b.querySelector("header") ?? b, b);
  expect(focusCounts()).toEqual(beforeNoop);
  fireEvent.dragStart(screen.getAllByRole("button", { name: "Tile 1 menu" })[0] ?? document.body, {
    dataTransfer: transfer,
  });
  fireEvent.dragStart(screen.container.querySelector(".tile-area") ?? document.body, {
    dataTransfer: transfer,
  });
  fireEvent.dragOver(document.body, { dataTransfer: transfer });
  vi.unstubAllGlobals();
});

test("empty-space placement marks only the drag target and clears on leave, end, cancel and drop", () => {
  const { screen, click, send, row } = setup();
  click(0);
  send("split-right");
  send("split-down");
  const empty = [...screen.container.querySelectorAll<HTMLElement>('[data-empty="true"]')];
  const landing = empty.find((tile) => tile.dataset["landing"] === "true");
  const other = empty.find((tile) => tile !== landing);
  const title = screen.container.querySelector(".tile-title");
  const area = screen.container.querySelector(".tile-area");
  if (!landing || !other || !title || !area) throw new Error("tiles");
  for (const tile of empty) {
    vi.spyOn(tile, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      right: 100,
      bottom: 100,
      toJSON: () => ({}),
    });
  }
  vi.stubGlobal("DragEvent", MouseEvent);
  const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  const over = (target: Element) =>
    fireEvent.dragOver(target, {
      dataTransfer: transfer,
      clientX: 50,
      clientY: 50,
    });
  const mark = () => screen.container.querySelector<HTMLElement>(".tile-drop-preview");
  expect(mark()).toBeNull();
  const saved = localStorage.getItem(TILE_STORAGE);
  for (const source of [row(1), title]) {
    fireEvent.dragStart(source, { dataTransfer: transfer });
    expect(mark()).toBeNull();
    over(landing);
    expect(mark()?.textContent).toBe("Place here");
    expect(area.textContent).toContain("Drop to place here");
    expect(mark()?.style.left).toBe(landing.style.left);
    over(other);
    expect(mark()?.style.left).toBe(other.style.left);
    expect(mark()?.style.top).toBe(other.style.top);
    fireEvent.dragLeave(area, { relatedTarget: document.body });
    expect(mark()).toBeNull();
    over(landing);
    fireEvent.dragEnd(source);
    expect(mark()).toBeNull();
    fireEvent.dragStart(source, { dataTransfer: transfer });
    over(landing);
    fireEvent.keyDown(area, { key: "Escape" });
    expect(mark()).toBeNull();
    expect(localStorage.getItem(TILE_STORAGE)).toBe(saved);
  }
  fireEvent.dragStart(row(1), { dataTransfer: transfer });
  over(other);
  fireEvent.drop(other, { dataTransfer: transfer, clientX: 50, clientY: 50 });
  expect(mark()).toBeNull();
  expect(other.dataset["empty"]).toBe("false");
  expect(landing.dataset["empty"]).toBe("true");
  vi.unstubAllGlobals();
});
