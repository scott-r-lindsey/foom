import type { InterfaceTheme } from "./interface-theme";
import type { TerminalTheme } from "./terminal-theme";
import type { ActiveThemeBitmaps, ThemeBitmapFiles } from "./theme-bitmap";
export type UserThemeId = `user:${string}`;
export type ThemeKind = "theme" | "terminal-theme";
export type ThemeReason =
  | "malformed-json"
  | "unknown-key"
  | "missing-key"
  | "not-a-color"
  | "attention-distinctness"
  | "color-distance"
  | "base-luminance"
  | "hole-color"
  | "contrast"
  | "gradient-not-allowed"
  | "reserved-color"
  | "too-large"
  | "unsafe-file"
  | "too-many-files"
  | "invalid-value"
  | "unreadable"
  | "image-unavailable"
  | "image-format"
  | "image-status-color";
export interface ThemeDiagnostic {
  severity?: "error" | "warning";
  file: string;
  path: string;
  reason: ThemeReason;
  /** Fixed validator explanation, never an argument value or raw exception. */
  detail?: string;
}
export type ParsedThemeFile =
  | {
      kind: "theme";
      theme: InterfaceTheme;
      images?: ThemeBitmapFiles;
      warnings?: readonly ThemeDiagnostic[];
    }
  | { kind: "terminal-theme"; name: string; theme: TerminalTheme };
export interface ThemeSnapshot {
  parsed: ParsedThemeFile;
  digest: string;
  imageDiagnostics?: readonly ThemeDiagnostic[];
}
export interface ThemeCatalog {
  activeInterfaceTheme?: UserThemeId;
  activeBitmaps?: ActiveThemeBitmaps;
  interface: readonly { id: UserThemeId; theme: InterfaceTheme; digest?: string }[];
  terminal: readonly { id: UserThemeId; name: string; theme: TerminalTheme }[];
  errors: readonly (ThemeDiagnostic & { kind: ThemeKind })[];
}
