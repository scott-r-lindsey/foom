import type { ThemeDiagnostic, UserThemeId } from "./theme-file";

export type ThemeBitmapSlot = "board" | "gutter" | "sidebar";
export interface ThemeBitmapStyle {
  opacity: number;
  fit: "cover" | "contain" | "tile";
  anchor:
    | "center"
    | "top"
    | "bottom"
    | "left"
    | "right"
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right";
}
export type ThemeBitmapFiles = Partial<
  Record<ThemeBitmapSlot, ThemeBitmapStyle & { file: string }>
>;
export type ThemeBitmapPaint = ThemeBitmapStyle & { id: string };
export interface ActiveThemeBitmaps {
  theme: UserThemeId;
  slots: Partial<Record<ThemeBitmapSlot, ThemeBitmapPaint>>;
}

/** Main-only. Only the paint projection and normalized PNG response cross the board boundary. */
export interface DecodedThemeBitmap {
  png: Uint8Array;
  colors: readonly string[];
}
export interface ThemeBitmapAsset {
  paint: ThemeBitmapPaint;
  png: Uint8Array;
  source: string;
}
export interface ThemeBitmapSnapshot {
  slots: Partial<Record<ThemeBitmapSlot, ThemeBitmapAsset>>;
  sources: Partial<Record<ThemeBitmapSlot, string>>;
  diagnostics: readonly ThemeDiagnostic[];
}
