/** Interface scale steps, in percent. 100 is the default. */
export const SCALES: readonly number[] = [80, 90, 100, 110, 120, 130, 140, 150];

export type ZoomDirection = "in" | "out" | "reset";

export function nextScale(current: number, direction: ZoomDirection): number {
  if (direction === "reset") return 100;
  const larger = SCALES.find((scale) => scale > current);
  const smaller = SCALES.findLast((scale) => scale < current);
  return (direction === "in" ? larger : smaller) ?? current;
}

export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Size {
  x: number;
  y: number;
}

/** The former starting size is the minimum at 100% interface scale. */
export const MINIMUM_SIZE: Size = { width: 900, height: 640 };

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** A size at this scale, never larger than the screen's usable area. */
export function scaledSize(size: Size, scale: number, area: Size): Size {
  return {
    width: Math.min(Math.round((size.width * scale) / 100), area.width),
    height: Math.min(Math.round((size.height * scale) / 100), area.height),
  };
}

/** Restore the saved size, or open at 60% of the work area, clamped to fit. */
export function initialSize(scale: number, area: Size, saved?: Size): Size {
  const minimum = scaledSize(MINIMUM_SIZE, scale, area);
  return {
    width: clamp(saved?.width ?? Math.round(area.width * 0.6), minimum.width, area.width),
    height: clamp(saved?.height ?? Math.round(area.height * 0.6), minimum.height, area.height),
  };
}

export interface Point {
  x: number;
  y: number;
}

/**
 * The window at a new scale: its content at 100% times the scale, plus the frame,
 * kept on the screen's usable area. The top-left corner goes to `origin` (by default,
 * where it is now) unless that would push the window off screen.
 */
export function scaledBounds(
  bounds: Rect,
  base: Size,
  scale: number,
  area: Rect,
  origin: Point = bounds,
  frame: Size = { width: 0, height: 0 },
): Rect {
  const minimum = scaledSize(MINIMUM_SIZE, scale, area);
  const content = scaledSize(base, scale, {
    width: area.width - frame.width,
    height: area.height - frame.height,
  });
  const width = Math.max(content.width + frame.width, minimum.width);
  const height = Math.max(content.height + frame.height, minimum.height);
  return {
    x: clamp(Math.round(origin.x), area.x, area.x + area.width - width),
    y: clamp(Math.round(origin.y), area.y, area.y + area.height - height),
    width,
    height,
  };
}

/**
 * Where the window's top-left goes so the page under `anchor` stays under it while
 * the page zooms by `ratio`. When the content grows by the same ratio, the layout in
 * CSS pixels doesn't change, so only the window's position needs to.
 */
export function anchoredOrigin(bounds: Rect, content: Rect, anchor: Point, ratio: number): Point {
  return {
    x: anchor.x - (anchor.x - content.x) * ratio - (content.x - bounds.x),
    y: anchor.y - (anchor.y - content.y) * ratio - (content.y - bounds.y),
  };
}
