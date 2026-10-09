import type { ThemeReason, UserThemeId } from "./theme-file";
export class ThemeValidationError extends Error {
  constructor(
    readonly path: string,
    readonly reason: ThemeReason,
  ) {
    super(`Invalid theme: ${path}: ${reason}`);
  }
}
export function validThemeFile(value: string): boolean {
  return value.length <= 100 && /^[\p{L}\p{N}_-][\p{L}\p{N} ._-]*\.json$/u.test(value);
}
export function isUserThemeId(value: unknown): value is UserThemeId {
  return typeof value === "string" && value.startsWith("user:") && validThemeFile(value.slice(5));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function themeRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ThemeValidationError(path, "invalid-value");
  return value;
}
export function themeKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  for (const key of Object.keys(value))
    if (!keys.includes(key) && !optional.includes(key))
      // Do not echo arbitrary property text or paths supplied by the file.
      throw new ThemeValidationError(path, "unknown-key");
  for (const key of keys)
    if (!Object.hasOwn(value, key)) throw new ThemeValidationError(`${path}.${key}`, "missing-key");
}
export function themeColor(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value))
    throw new ThemeValidationError(path, "not-a-color");
  return value;
}
