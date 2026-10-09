import type { ThemeCatalog } from "./theme-file";
import { isUserThemeId } from "./theme-validation";
import type { TerminalTheme, TerminalThemeChoice, TerminalThemeId } from "./terminal-theme";
export const ansiNames = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const base = {
  black: "#2e3436",
  red: "#cc0000",
  green: "#4e9a06",
  yellow: "#c4a000",
  blue: "#3465a4",
  magenta: "#75507b",
  cyan: "#06989a",
  white: "#d3d7cf",
  brightBlack: "#555753",
  brightRed: "#ef2929",
  brightGreen: "#8ae234",
  brightYellow: "#fce94f",
  brightBlue: "#729fcf",
  brightMagenta: "#ad7fa8",
  brightCyan: "#34e2e2",
  brightWhite: "#eeeeec",
};
const solarized = {
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};
export const terminalThemes: Readonly<Record<Exclude<TerminalThemeId, "follow">, TerminalTheme>> = {
  "foom-dark": {
    ...base,
    foreground: "#f4efff",
    background: "#05040a",
    cursor: "#9b6bff",
    selectionBackground: "#251d3f",
  },
  "foom-light": {
    ...base,
    foreground: "#14101f",
    background: "#f3f0fa",
    cursor: "#5b2bd9",
    selectionBackground: "#ddd6ee",
  },
  "solarized-dark": {
    ...solarized,
    foreground: "#839496",
    background: "#002b36",
    cursor: "#93a1a1",
    selectionBackground: "#073642",
  },
  "solarized-light": {
    ...solarized,
    foreground: "#657b83",
    background: "#fdf6e3",
    cursor: "#586e75",
    selectionBackground: "#eee8d5",
  },
  dracula: {
    foreground: "#f8f8f2",
    background: "#282a36",
    cursor: "#f8f8f2",
    selectionBackground: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
};
export const terminalThemeOptions: readonly { id: TerminalThemeId; name: string }[] = [
  { id: "follow", name: "Follow interface" },
  { id: "foom-dark", name: "Foom Dark" },
  { id: "foom-light", name: "Foom Light" },
  { id: "solarized-dark", name: "Solarized Dark" },
  { id: "solarized-light", name: "Solarized Light" },
  { id: "dracula", name: "Dracula" },
];
const keys = ["foreground", "background", "cursor", "selectionBackground", ...ansiNames] as const;
export function isTerminalTheme(value: unknown): value is TerminalTheme {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => {
      const color: unknown = Reflect.get(value, key);
      return (
        Object.hasOwn(value, key) && typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)
      );
    })
  );
}
export function parseTerminalThemeChoice(value: unknown): TerminalThemeChoice {
  if (isUserThemeId(value)) return value;
  if (typeof value === "string") {
    const option = terminalThemeOptions.find((option) => option.id === value);
    if (option) return option.id;
  } else if (isTerminalTheme(value)) return { ...value };
  throw new Error("Invalid terminal theme");
}
export function resolveTerminalTheme(
  choice: TerminalThemeChoice,
  dark: boolean,
  catalog?: ThemeCatalog,
): TerminalTheme {
  if (typeof choice !== "string") return choice;
  if (isUserThemeId(choice))
    return (
      catalog?.terminal.find((entry) => entry.id === choice)?.theme ??
      terminalThemes[dark ? "foom-dark" : "foom-light"]
    );
  return terminalThemes[choice === "follow" ? (dark ? "foom-dark" : "foom-light") : choice];
}
