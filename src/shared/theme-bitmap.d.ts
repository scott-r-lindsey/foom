import type { ThemeDiagnostic, UserThemeId } from "./theme-file";

export type ThemeBitmapSlot = "empty" | "sidebar" | "tile-header";
export interface ThemeBitmapStyle {
  opacity: number;
  fit: "cover" | "contain" | "tile" | "none";
  size?: number;
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
export type ThemeBitmapPiece = ThemeBitmapStyle & { file: string };
export type ThemeBitmapFiles = Partial<Record<ThemeBitmapSlot, readonly ThemeBitmapPiece[]>>;
export type ThemeBitmapPaint = ThemeBitmapStyle & { id: string };
export interface ActiveThemeBitmaps {
  theme: UserThemeId;
  slots: Partial<Record<ThemeBitmapSlot, readonly ThemeBitmapPaint[]>>;
}

/** Main-only. Only the paint projection and normalized PNG response cross the board boundary. */
export interface DecodedThemeBitmap {
  png: Uint8Array;
  colors: readonly string[];
}
export interface ThemeBitmapAsset {
  paint: ThemeBitmapPaint;
  png: Uint8Array;
  /** Main-only identity of the filename and source bytes. */
  source: string;
}
export interface ThemeBitmapSnapshot {
  slots: Partial<Record<ThemeBitmapSlot, readonly ThemeBitmapAsset[]>>;
  diagnostics: readonly ThemeDiagnostic[];
}

/** Private profile baseline. Older records contain the full theme JSON digest. */
export type ThemeApproval = string | { readonly paletteDigest: string };
