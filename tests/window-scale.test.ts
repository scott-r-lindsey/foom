import { beforeEach, expect, test, vi } from "vitest";
import type { Rect } from "../src/appearance";
import { attachWindowScale } from "../src/window-scale";

let bounds: Rect;
let resize: (() => void) | undefined;
const window = {
  getBounds: () => bounds,
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
});

test("zooming in and back out returns to the same window, even after hitting an edge", () => {
  const apply = attachWindowScale(window, () => area, 100);
  apply(110);
  expect(bounds).toEqual({ x: 100, y: 100, width: 990, height: 704 });
  expect(window.setMinimumSize).toHaveBeenLastCalledWith(528, 462);
  resize?.();
  apply(150);
  // Capped by the screen and moved back onto it.
  expect(bounds).toEqual({ x: 0, y: 64, width: 1280, height: 960 });
  resize?.();
  // The size comes back exactly; the position stays where the edge put it.
  apply(100);
  expect(bounds).toEqual({ x: 0, y: 64, width: 900, height: 640 });
  expect(window.setMinimumSize).toHaveBeenLastCalledWith(480, 420);
  apply(100);
  expect(window.setBounds).toHaveBeenCalledTimes(3);
});

test("a resize by the user sets a new size at 100%", () => {
  const apply = attachWindowScale(window, () => area, 120);
  bounds = { ...bounds, width: 1200, height: 720 };
  resize?.();
  apply(100);
  expect(bounds).toMatchObject({ width: 1000, height: 600 });
});

test("maximized and full-screen windows keep their size but get the new minimum", () => {
  const apply = attachWindowScale(window, () => area, 100);
  window.isMaximized.mockReturnValue(true);
  bounds = { x: 0, y: 0, width: 1280, height: 1024 };
  resize?.();
  apply(120);
  expect(window.setBounds).not.toHaveBeenCalled();
  expect(window.setMinimumSize).toHaveBeenCalledWith(576, 504);
  window.isMaximized.mockReturnValue(false);
  window.isFullScreen.mockReturnValue(true);
  apply(130);
  expect(window.setBounds).not.toHaveBeenCalled();
  // Leaving full screen: the size at 100% is still the one from before maximizing.
  window.isFullScreen.mockReturnValue(false);
  apply(100);
  expect(bounds).toMatchObject({ width: 900, height: 640 });
});
