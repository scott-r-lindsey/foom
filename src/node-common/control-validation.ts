export class ControlError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "capacity"
      | "unavailable",
  ) {
    super(code);
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ControlError("invalid_request");
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new ControlError("invalid_request");
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/u.test(value))
    throw new ControlError("invalid_request");
  return value;
}
