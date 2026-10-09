import type { ParsedThemeFile, ThemeKind } from "./theme-file";
import {
  interfaceColorNames,
  interfaceHighlightNames,
  parseInterfaceTheme,
} from "./interface-themes";
import { ansiNames, isTerminalTheme } from "./terminal-themes";
import { ThemeValidationError, themeColor, themeKeys, themeRecord } from "./theme-validation";
/** Browser-safe parser shared by the app and the future offline CLI. */
export function parseThemeFile(text: string, kind: ThemeKind): ParsedThemeFile {
  if (new TextEncoder().encode(text).length > 65536)
    throw new ThemeValidationError("$", "too-large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ThemeValidationError("$", "malformed-json");
  }
  const value = themeRecord(parsed, "$");
  themeKeys(
    value,
    kind === "theme"
      ? ["kind", "name", "base", "colors"]
      : ["kind", "name", "background", "foreground", "cursor", "ansi"],
    "$",
  );
  if (value["kind"] !== kind) throw new ThemeValidationError("$.kind", "invalid-value");
  const name = value["name"];
  if (typeof name !== "string" || !/^[\p{L}\p{N} ._-]{1,40}$/u.test(name) || !name.trim())
    throw new ThemeValidationError("$.name", "invalid-value");
  if (kind === "theme") {
    const colors = themeRecord(value["colors"], "$.colors");
    themeKeys(colors, interfaceColorNames, "$.colors", interfaceHighlightNames);
    for (const key of [...interfaceColorNames, ...interfaceHighlightNames])
      if (Object.hasOwn(colors, key)) themeColor(colors[key], `$.colors.${key}`);
    for (const key of interfaceHighlightNames)
      if (
        Object.hasOwn(colors, key) &&
        !Object.hasOwn(colors, key === "highlight" ? "highlight-deep" : "highlight")
      )
        throw new ThemeValidationError(
          `$.colors.${key === "highlight" ? "highlight-deep" : "highlight"}`,
          "missing-key",
        );
    const base = value["base"];
    if (base !== "dark" && base !== "light")
      throw new ThemeValidationError("$.base", "invalid-value");
    const theme = parseInterfaceTheme({ version: 1, name, base, colors });
    if (typeof theme === "string") throw new ThemeValidationError("$", "invalid-value");
    return { kind, theme };
  }
  const background = themeColor(value["background"], "$.background");
  const foreground = themeColor(value["foreground"], "$.foreground");
  const cursor = themeColor(value["cursor"], "$.cursor");
  const ansi = value["ansi"];
  if (!Array.isArray(ansi) || ansi.length !== 16)
    throw new ThemeValidationError("$.ansi", "invalid-value");
  const palette = Object.fromEntries(
    ansiNames.map((key, index) => [key, themeColor(ansi[index], `$.ansi[${String(index)}]`)]),
  );
  // The file format has no selection field. ANSI bright black is the selection fill.
  const theme = {
    ...palette,
    background,
    foreground,
    cursor,
    selectionBackground: themeColor(ansi[8], "$.ansi[8]"),
  };
  if (!isTerminalTheme(theme)) throw new ThemeValidationError("$", "invalid-value");
  return { kind, name, theme };
}
