import { anchoredOrigin, MINIMUM_SIZE, scaledBounds, scaledSize } from "./appearance";
import type { Point, Rect, Size } from "./appearance";

type ScaledWindow = {
  getBounds(): Rect;
  getContentBounds(): Rect;
  setBounds(bounds: Rect): void;
  setMinimumSize(width: number, height: number): void;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  on(event: "resize", listener: () => void): unknown;
};

const inside = (point: Point, rect: Rect) =>
  point.x >= rect.x &&
  point.y >= rect.y &&
  point.x < rect.x + rect.width &&
  point.y < rect.y + rect.height;

export interface WindowScale {
  /** Resize the window for a new interface scale. */
  apply: (scale: number) => void;
  /**
   * Grow or shrink from this screen point on the next resize, so whatever is under
   * the pointer stays under it; undefined goes back to keeping the top-left corner.
   */
  anchorAt: (point: Point | undefined) => void;
}

/**
 * Keeps the window's size in step with interface zoom, both ways. It remembers the
 * content's size at 100% so zooming in and back out returns to the same window, and a
 * resize by the user sets a new size at 100%. Maximized and full-screen windows
 * aren't resized.
 */
export function attachWindowScale(
  window: ScaledWindow,
  workArea: (bounds: Rect) => Rect,
  initialScale: number,
): WindowScale {
  let scale = initialScale;
  let anchor: Point | undefined;
  const toBase = (size: Size): Size => ({
    width: (size.width * 100) / scale,
    height: (size.height * 100) / scale,
  });
  let base = toBase(window.getContentBounds());
  // Our own resizes also raise "resize"; only a different size came from the user.
  let expected: Size | undefined;
  window.on("resize", () => {
    const { width, height } = window.getBounds();
    if (
      expected &&
      Math.abs(width - expected.width) <= 2 &&
      Math.abs(height - expected.height) <= 2
    )
      return;
    expected = undefined;
    if (!window.isMaximized() && !window.isFullScreen()) base = toBase(window.getContentBounds());
  });
  return {
    anchorAt: (point) => {
      anchor = point;
    },
    apply: (next) => {
      if (next === scale) return;
      const ratio = next / scale;
      scale = next;
      const bounds = window.getBounds();
      const content = window.getContentBounds();
      const area = workArea(bounds);
      const minimum = scaledSize(MINIMUM_SIZE, scale, area);
      window.setMinimumSize(minimum.width, minimum.height);
      if (window.isMaximized() || window.isFullScreen()) return;
      // Only a pointer inside the page anchors; elsewhere it didn't click anything here.
      const origin =
        anchor && inside(anchor, content) ? anchoredOrigin(bounds, content, anchor, ratio) : bounds;
      const frame = {
        width: bounds.width - content.width,
        height: bounds.height - content.height,
      };
      const target = scaledBounds(bounds, base, scale, area, origin, frame);
      expected = target;
      window.setBounds(target);
    },
  };
}
