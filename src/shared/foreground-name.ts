/** A process name, never a path, command line, control sequence or argument list. */
export function foregroundName(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_+@.()-]+$/.test(value) ? value.slice(0, 32) : "";
}
