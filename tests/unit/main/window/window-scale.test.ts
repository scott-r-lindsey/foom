import { beforeEach, expect, test, vi } from "vitest";
import type { Rect } from "../../../../src/main/window/appearance";
import { attachWindowScale } from "../../../../src/main/window/window-scale";

let bounds: Rect;
/** The frame around the page: none, unless a test sets a title bar. */
let titleBar = 0;
let resize: (() => void) | undefined;
const window = {
  getBounds: () => bounds,
  getContentBounds: () => ({
    x: bounds.x,
    y: bounds.y + titleBar,
    width: bounds.width,
    height: bounds.height - titleBar,
  }),
  setBounds: vi.fn((next: Rect) => {
    bounds = next;
  }),
  setMinimumSize: vi.fn(),
  isMaximized: vi.fn(() => false),
  isFullScreen: vi.fn(() => false),
  on: vi.fn((_event: "resize", listener: () => void) => {
    resize = listener;
  }),
};
const area = { x: 0, y: 0, width: 1280, height: 1024 };

beforeEach(() => {
  vi.clearAllMocks();
  window.isMaximized.mockReturnValue(false);
  window.isFullScreen.mockReturnValue(false);
  bounds = { x: 100, y: 100, width: 900, height: 640 };
  titleBar = 0;
});

test("zooming in and back out returns to the same window, even after hitting an edge", () => {
  const { apply } = attachWindowScale(window, () => area, 100);
  apply(110);
  expect(bounds).toEqual({ x: 100, y: 100, width: 990, height: 704 });
  expect(window.setMinimumSize).toHaveBeenLastCalledWith(990, 704);
  resize?.();
  apply(150);
  // Capped by the screen and moved back onto it.
  expect(bounds).toEqual({ x: 0, y: 64, width: 1280, height: 960 });
  resize?.();
  // The size comes back exactly; the position stays where the edge put it.
  apply(100);
  expect(bounds).toEqual({ x: 0, y: 64, width: 900, height: 640 });
  expect(window.setMinimumSize).toHaveBeenLastCalledWith(900, 640);
  apply(100);
  expect(window.setBounds).toHaveBeenCalledTimes(3);
});

test("a resize by the user sets a new size at 100%", () => {
  const { apply } = attachWindowScale(window, () => area, 120);
  bounds = { ...bounds, width: 1200, height: 840 };
  resize?.();
  apply(100);
  expect(bounds).toMatchObject({ width: 1000, height: 700 });
});

test("zoom reset shrinks a window macOS reports maximized after our own resize", () => {
  const smallScreen = { x: 0, y: 0, width: 1024, height: 684 };
  window.isMaximized.mockImplementation(
    () => bounds.width === smallScreen.width && bounds.height === smallScreen.height,
  );
  const { apply } = attachWindowScale(window, () => smallScreen, 100);
  apply(120);
  resize?.();
  expect(window.isMaximized()).toBe(true);
  apply(100);
  expect(bounds).toMatchObject({ width: 900, height: 640 });
});

test("maximized and full-screen windows keep their size but get the new minimum", () => {
  const { apply } = attachWindowScale(window, () => area, 100);
  window.isMaximized.mockReturnValue(true);
  bounds = { x: 0, y: 0, width: 1280, height: 1024 };
  resize?.();
  apply(120);
  expect(window.setBounds).not.toHaveBeenCalled();
  expect(window.setMinimumSize).toHaveBeenCalledWith(1080, 768);
  window.isMaximized.mockReturnValue(false);
  window.isFullScreen.mockReturnValue(true);
  apply(130);
  expect(window.setBounds).not.toHaveBeenCalled();
  // Leaving full screen: the size at 100% is still the one from before maximizing.
  window.isFullScreen.mockReturnValue(false);
  apply(100);
  expect(bounds).toMatchObject({ width: 900, height: 640 });
});

test("a click grows the window from the pointer, so the page under it stays put", () => {
  titleBar = 30;
  bounds = { x: 200, y: 200, width: 900, height: 670 };
  const scale = attachWindowScale(window, () => area, 100);
  // The pointer is over a button 100px into the page and 500px down it.
  const pointer = { x: 300, y: 730 };
  const onScreen = (cssX: number, cssY: number, zoom: number) => {
    const content = window.getContentBounds();
    return { x: content.x + cssX * zoom, y: content.y + cssY * zoom };
  };
  expect(onScreen(100, 500, 1)).toEqual(pointer);
  scale.anchorAt(pointer);
  scale.apply(110);
  // The page grew by exactly the zoom, so its layout is unchanged...
  expect(window.getContentBounds()).toMatchObject({ width: 990, height: 704 });
  // ...and the button is still under the pointer.
  expect(onScreen(100, 500, 1.1)).toEqual(pointer);
  scale.apply(100);
  expect(onScreen(100, 500, 1)).toEqual(pointer);
  expect(bounds).toEqual({ x: 200, y: 200, width: 900, height: 670 });

  // Without an anchor, or with the pointer outside the page, the top-left stays.
  scale.anchorAt(undefined);
  scale.apply(110);
  expect(bounds).toMatchObject({ x: 200, y: 200 });
  scale.anchorAt({ x: 10, y: 10 });
  scale.apply(100);
  expect(bounds).toMatchObject({ x: 200, y: 200 });
});

test("an anchored window still stays on the screen", () => {
  const scale = attachWindowScale(window, () => area, 100);
  scale.anchorAt({ x: 950, y: 700 });
  scale.apply(150);
  // Growing from the pointer would put the top 200px above the screen.
  expect(bounds).toEqual({ x: 0, y: 0, width: 1280, height: 960 });
});
