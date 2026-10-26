/** Reject whole selections above the shared UTF-16 code-unit bound. */
export function isTerminalSelection(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 65_536;
}
