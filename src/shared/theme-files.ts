import type { ParsedThemeFile, ThemeKind } from "./theme-file";
import { parseUserInterfaceTheme, userThemeWarnings } from "./user-interface-theme";
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
      ? [Object.hasOwn(value, "kind") ? "kind" : "version", "name", "base", "colors"]
      : ["kind", "name", "background", "foreground", "cursor", "ansi"],
    "$",
    kind === "theme"
      ? ["version", ...(value["version"] === 2 ? ["areas", "states", "shape"] : [])]
      : [],
  );
  if ((Object.hasOwn(value, "kind") || kind !== "theme") && value["kind"] !== kind)
    throw new ThemeValidationError("$.kind", "invalid-value");
  const name = value["name"];
  if (typeof name !== "string" || !/^[\p{L}\p{N} ._-]{1,40}$/u.test(name) || !name.trim())
    throw new ThemeValidationError("$.name", "invalid-value");
  if (kind === "theme") {
    const theme = parseUserInterfaceTheme(value);
    const warnings = userThemeWarnings(theme);
    return { kind, theme, ...(warnings.length ? { warnings } : {}) };
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
