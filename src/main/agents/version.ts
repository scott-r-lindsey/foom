/** Accept stable numeric releases, retaining the full probe string for display. */
export function meetsMinimum(
  version: string,
  pattern: RegExp,
  minimum: readonly number[],
): boolean {
  const match = pattern.exec(version);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  for (const [index, floor] of minimum.entries()) {
    const part = parts[index];
    if (part === undefined) throw new Error("Incomplete version pattern");
    if (part !== floor) return part > floor;
  }
  return true;
}
