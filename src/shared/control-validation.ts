export class ControlError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "unauthorized"
      | "forbidden"
      | "no_parent"
      | "not_found"
      | "conflict"
      | "capacity"
      | "unavailable"
      | "forge_unavailable"
      | "pr_not_open"
      | "pr_from_fork"
      | "default_branch"
      | "invalid_branch"
      | "branch_in_use"
      | "branch_diverged"
      | "remote_review_unsupported",
  ) {
    super(code);
  }
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new ControlError("invalid_request");
  return value;
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
