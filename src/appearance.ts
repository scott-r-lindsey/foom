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
