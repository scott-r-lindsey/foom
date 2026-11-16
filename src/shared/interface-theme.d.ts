import type { UserThemeId } from "./theme-file";
/** Every color token. User typography can select only bundled or system stacks. */
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
  version: 1 | 2;
  areas?: Partial<Record<InterfaceArea, InterfaceAreaTheme>>;
  states?: Partial<Record<InterfaceState, string>>;
  type?: InterfaceTypography;
  shape?: Partial<Record<InterfaceShape, number>>;
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
/** The stored follow ID is shown as Default and follows OS appearance live. */
export type InterfaceThemeChoice = "follow" | InterfaceThemeId | UserThemeId | InterfaceTheme;

export type InterfaceArea =
  | "sidebar"
  | "tiles"
  | "panels"
  | "dialogs"
  | "menus"
  | "titlebar"
  | "tile-headers"
  | "board"
  | "badges"
  | "wordmark"
  | "dialog-headers";
export interface InterfaceGradient {
  angle: number;
  stops: readonly (readonly [string, number])[];
}
export type InterfaceAreaTheme = Partial<InterfaceTheme["colors"]> & {
  scrollbar?: string;
  gradient?: InterfaceGradient;
};
export interface InterfaceTypography {
  family?: "geist" | "geist-mono" | "system" | "system-mono";
  scale?: number;
  weight?: number;
  "strong-weight"?: number;
}
export type InterfaceState = "selected" | "hover" | "focus" | "scrollbar";
export type InterfaceShape = "radius" | "panel-radius" | "border" | "shadow";
