import type { InterfaceTheme } from "./interface-theme";
import type { TerminalTheme } from "./terminal-theme";
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
  | "reserved-color"
  | "too-large"
  | "unsafe-file"
  | "too-many-files"
  | "invalid-value"
  | "unreadable";
export interface ThemeDiagnostic {
  severity?: "error" | "warning";
  file: string;
  path: string;
  reason: ThemeReason;
}
export type ParsedThemeFile =
  | { kind: "theme"; theme: InterfaceTheme; warnings?: readonly ThemeDiagnostic[] }
  | { kind: "terminal-theme"; name: string; theme: TerminalTheme };
export interface ThemeCatalog {
  interface: readonly { id: UserThemeId; theme: InterfaceTheme }[];
  terminal: readonly { id: UserThemeId; name: string; theme: TerminalTheme }[];
  errors: readonly (ThemeDiagnostic & { kind: ThemeKind })[];
}
