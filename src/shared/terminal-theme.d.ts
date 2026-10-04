/** Portable palette for built-ins and future user theme files. Colors are #RRGGBB. */
export interface TerminalTheme {
  foreground: string;
  background: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}
export type TerminalThemeId =
  | "follow"
  | "foom-dark"
  | "foom-light"
  | "solarized-dark"
  | "solarized-light"
  | "dracula";
export type TerminalThemeChoice = TerminalThemeId | TerminalTheme;
