import type { UserThemeId } from "./theme-file";
/** Every color token; typography stays bundled and is not user-configurable. */
export type InterfaceColor =
  | "bg"
  | "surface"
  | "line"
  | "ink"
  | "muted"
  | "accent"
  | "accent-deep"
  | "attention"
  | "attention-ink"
  | "done"
  | "done-ink"
  | "failed"
  | "failed-ink"
  | "hole"
  | "space-ink"
  | "badge-label-fill"
  | "badge-label-ink"
  | "badge-fill"
  | "badge-ink";
export interface InterfaceTheme {
  version: 1;
  name: string;
  base: "light" | "dark";
  colors: Readonly<
    Record<InterfaceColor, string> & { highlight?: string; "highlight-deep"?: string }
  >;
}
export type InterfaceThemeId =
  | "eclipse-light"
  | "eclipse-dark"
  | "high-contrast"
  | "deep-field"
  | "moonlight"
  | "graphite"
  | "midnight-indigo";
/** Follow preserves the preflight System/Light/Dark preference and existing profiles. */
export type InterfaceThemeChoice = "follow" | InterfaceThemeId | UserThemeId | InterfaceTheme;
