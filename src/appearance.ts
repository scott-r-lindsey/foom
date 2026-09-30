import type { Input } from "electron";

/** Interface scale steps, in percent. 100 is the default. */
export const SCALES: readonly number[] = [80, 90, 100, 110, 120, 130, 140, 150];

export type ZoomDirection = "in" | "out" | "reset";

export function nextScale(current: number, direction: ZoomDirection): number {
  if (direction === "reset") return 100;
  const larger = SCALES.find((scale) => scale > current);
  const smaller = SCALES.findLast((scale) => scale < current);
  return (direction === "in" ? larger : smaller) ?? current;
}

/**
 * Interface zoom keys. macOS uses ⌘ with =, − and 0, which a terminal never receives.
 * Elsewhere Ctrl+− is readline's undo (^_), so zooming in and out needs Shift too,
 * like Ctrl+Shift+C and V; Ctrl+0 resets. Matched by physical key, so layouts agree.
 */
export function zoomShortcut(
  input: Pick<Input, "type" | "code" | "control" | "shift" | "alt" | "meta">,
  platform: NodeJS.Platform,
): ZoomDirection | undefined {
  if (input.type !== "keyDown" || input.alt) return undefined;
  const direction =
    input.code === "Equal" || input.code === "NumpadAdd"
      ? "in"
      : input.code === "Minus" || input.code === "NumpadSubtract"
        ? "out"
        : input.code === "Digit0" || input.code === "Numpad0"
          ? "reset"
          : undefined;
  if (!direction) return undefined;
  if (platform === "darwin") return input.meta && !input.control ? direction : undefined;
  if (input.meta || !input.control) return undefined;
  return direction === "reset" || input.shift ? direction : undefined;
}

export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Size {
  x: number;
  y: number;
}

/** The window's size at 100%, and its smallest usable size. */
export const BASE_SIZE: Size = { width: 900, height: 640 };
export const MINIMUM_SIZE: Size = { width: 480, height: 420 };

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** A size at this scale, never larger than the screen's usable area. */
export function scaledSize(size: Size, scale: number, area: Size): Size {
  return {
    width: Math.min(Math.round((size.width * scale) / 100), area.width),
    height: Math.min(Math.round((size.height * scale) / 100), area.height),
  };
}

/**
 * The window at a new scale: its size at 100% times the scale, kept on the screen's
 * usable area. The top-left corner stays put unless that would push it off screen.
 */
export function scaledBounds(bounds: Rect, base: Size, scale: number, area: Rect): Rect {
  const minimum = scaledSize(MINIMUM_SIZE, scale, area);
  const target = scaledSize(base, scale, area);
  const width = Math.max(target.width, minimum.width);
  const height = Math.max(target.height, minimum.height);
  return {
    x: clamp(bounds.x, area.x, area.x + area.width - width),
    y: clamp(bounds.y, area.y, area.y + area.height - height),
    width,
    height,
  };
}
