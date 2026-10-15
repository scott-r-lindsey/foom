import { AgentManifestError } from "./agent-manifest";
export function fail(path: string, reason = "invalid-value"): never {
  throw new AgentManifestError(path, reason);
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function object(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) fail(path);
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)))
    fail(path, "unknown-key");
  if (required.some((key) => !Object.hasOwn(value, key))) fail(path, "missing-key");
  return value;
}
export function text(value: unknown, path: string, max = 4096, min = 1): string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029]/u.test(value)
  )
    fail(path);
  return value;
}
export function pattern(value: unknown, path: string, expression: RegExp, max: number): string {
  const result = text(value, path, max);
  if (!expression.test(result)) fail(path);
  return result;
}
export const id = (value: unknown, path: string) => pattern(value, path, /^[a-z][a-z0-9-]*$/u, 40);
export const localId = (value: unknown, path: string) =>
  pattern(value, path, /^[A-Za-z][A-Za-z0-9_-]*$/u, 40);
export const flag = (value: unknown, path: string) =>
  pattern(value, path, /^--?[A-Za-z][A-Za-z0-9-]*$/u, 64);
export function basename(value: unknown, path: string): string {
  const result = pattern(value, path, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u, 64);
  if (/\.(cmd|bat|ps1)$/iu.test(result)) fail(path);
  return result;
}
export function relative(value: unknown, path: string, hidden = false): string {
  const result = text(value, path, 100);
  const parts = result.split("/");
  if (
    parts.length > (hidden ? 5 : 4) ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_.-]+$/u.test(part) ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) ||
        (!hidden && part.startsWith(".")),
    )
  )
    fail(path, "unsafe-file");
  return result;
}
export function integer(
  value: unknown,
  path: string,
  max = Number.MAX_SAFE_INTEGER,
  min = 0,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    fail(path);
  return value;
}
export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path);
  return value;
}
export function literal<T extends string | number>(expected: T) {
  return (value: unknown, path: string): T => {
    if (value !== expected) fail(path);
    return expected;
  };
}
export function enumeration<T extends string>(...choices: T[]) {
  return (value: unknown, path: string): T => {
    const result = choices.find((choice) => choice === value);
    if (result === undefined) fail(path);
    return result;
  };
}
export function array<T>(parse: (value: unknown, path: string) => T, max: number, min = 0) {
  return (value: unknown, path: string): T[] => {
    if (!Array.isArray(value) || value.length < min || value.length > max) fail(path);
    return value.map((entry: unknown, index) => parse(entry, `${path}[${String(index)}]`));
  };
}
export function optional<T>(parse: (value: unknown, path: string) => T) {
  return (value: unknown, path: string): T | undefined =>
    value === undefined ? undefined : parse(value, path);
}
export function defaulted<T>(parse: (value: unknown, path: string) => T, fallback: T) {
  return (value: unknown, path: string): T => (value === undefined ? fallback : parse(value, path));
}
export function unique<T>(
  values: T[],
  path: string,
  key: (value: T) => unknown = (value) => value,
): T[] {
  if (new Set(values.map(key)).size !== values.length) fail(path, "duplicate-id");
  return values;
}
export function primitive(value: unknown, path: string): string | number | boolean | null {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path);
    return value;
  }
  return text(value, path);
}
export function multiline(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length > 16384 ||
    /[\p{Cf}\p{Co}\p{Cs}\u2028\u2029]|[^\P{Cc}\n\t]/u.test(value)
  )
    fail(path);
  return value;
}
export function versionText(value: unknown, path: string): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > 256) fail(path);
  text(value.replaceAll("\n", ""), path, 256, 0);
  return value;
}
