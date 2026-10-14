/** Family names are data, never CSS syntax. Keep quotes and all controls out. */
export function isTerminalFont(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    value === value.trim() &&
    /^[\p{L}\p{N}][\p{L}\p{N} ._()+-]*$/u.test(value)
  );
}

export const DEFAULT_TERMINAL_FONT = "Hack Nerd Font Mono";
export const TERMINAL_FONT_FALLBACK = '"Hack Nerd Font Mono", "Geist Mono", monospace';

/** Revalidate even main-owned settings before building a CSS font stack. */
export function terminalFontStack(value: unknown): string {
  return isTerminalFont(value) && value !== DEFAULT_TERMINAL_FONT
    ? `"${value}", ${TERMINAL_FONT_FALLBACK}`
    : TERMINAL_FONT_FALLBACK;
}

/** Both the process output and the IPC result are untrusted, bounded lists. */
export function terminalFontFamilies(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10000) return [];
  return [...new Set(value.filter(isTerminalFont))]
    .filter((family) => family !== DEFAULT_TERMINAL_FONT)
    .sort((a, b) => a.localeCompare(b));
}
