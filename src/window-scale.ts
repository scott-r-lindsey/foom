import { MINIMUM_SIZE, scaledBounds, scaledSize } from "./appearance";
import type { Rect, Size } from "./appearance";

type ScaledWindow = {
  getBounds(): Rect;
  setBounds(bounds: Rect): void;
  setMinimumSize(width: number, height: number): void;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  on(event: "resize", listener: () => void): unknown;
};

/**
 * Keeps the window's size in step with interface zoom, both ways. It remembers the
 * window's size at 100% so zooming in and back out returns to the same window, and a
 * resize by the user sets a new size at 100%. Maximized and full-screen windows
 * aren't resized.
 */
export function attachWindowScale(
  window: ScaledWindow,
  workArea: (bounds: Rect) => Rect,
  initialScale: number,
): (scale: number) => void {
  let scale = initialScale;
  const toBase = (size: Size): Size => ({
    width: (size.width * 100) / scale,
    height: (size.height * 100) / scale,
  });
  let base = toBase(window.getBounds());
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
    if (!window.isMaximized() && !window.isFullScreen()) base = toBase({ width, height });
  });
  return (next) => {
    if (next === scale) return;
    scale = next;
    const bounds = window.getBounds();
    const area = workArea(bounds);
    const minimum = scaledSize(MINIMUM_SIZE, scale, area);
    window.setMinimumSize(minimum.width, minimum.height);
    if (window.isMaximized() || window.isFullScreen()) return;
    const target = scaledBounds(bounds, base, scale, area);
    expected = target;
    window.setBounds(target);
  };
}
