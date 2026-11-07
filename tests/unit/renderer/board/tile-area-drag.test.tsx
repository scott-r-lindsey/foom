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
  expect(views[0]?.open).toHaveBeenLastCalledWith("check");
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

test("an impossible edge drop shows its reason and preserves the source and destination", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return DOMRect.fromRect({
      width: this.tagName === "SPAN" ? 8.4 : 180,
      height: 200,
    });
  });
  vi.stubGlobal("DragEvent", MouseEvent);
  const { screen, click, row } = setup();
  click(0);
  await act(async () => {});
  const target = screen.container.querySelector<HTMLElement>('[data-empty="false"]');
  if (!target) throw new Error("Missing tile");
  const saved = localStorage.getItem(TILE_STORAGE);
  const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(row(2), { dataTransfer: transfer });
  fireEvent.dragOver(target, { dataTransfer: transfer, clientX: 10, clientY: 100 });
  expect(transfer.dropEffect).toBe("none");
  expect(screen.container.querySelector(".tile-drop-preview")?.textContent).toBe(
    "Too narrow to split",
  );
  fireEvent.drop(target, { dataTransfer: transfer, clientX: 10, clientY: 100 });
  expect(localStorage.getItem(TILE_STORAGE)).toBe(saved);
});

test.each(["title", "sidebar"])("%s self edge drops have no split feedback or effect", (kind) => {
  vi.stubGlobal("DragEvent", MouseEvent);
  const { screen, click, row, views } = setup();
  click(0);
  const tile = screen.container.querySelector<HTMLElement>('[data-empty="false"]');
  if (!tile) throw new Error("Missing tile");
  vi.spyOn(tile, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ width: 100, height: 100 }),
  );
  const source = kind === "title" ? (tile.querySelector("header") ?? tile) : row(0);
  const saved = localStorage.getItem(TILE_STORAGE);
  const focused = document.activeElement;
  const focusCalls = views.map((v) => v.focus.mock.calls.length);
  const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  fireEvent.dragStart(source, { dataTransfer: transfer });
  fireEvent.dragOver(tile, { dataTransfer: transfer, clientX: 99, clientY: 50 });
  expect(transfer.dropEffect).toBe("none");
  expect(screen.container.querySelector(".tile-drop-preview")).toBeNull();
  expect(screen.container.querySelector('.tile-area [role="status"]')?.textContent).not.toMatch(
    /split/i,
  );
  fireEvent.drop(tile, { dataTransfer: transfer, clientX: 99, clientY: 50 });
  expect(localStorage.getItem(TILE_STORAGE)).toBe(saved);
  expect(document.activeElement).toBe(focused);
  expect(views.map((v) => v.focus.mock.calls.length)).toEqual(focusCalls);
});
