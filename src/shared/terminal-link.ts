/** Long OAuth targets fit; oversized or presentation-control-bearing URLs refuse whole. */
export const TERMINAL_LINK_LIMIT = 16_384;

export function terminalLink(value: unknown): URL | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > TERMINAL_LINK_LIMIT ||
    /[\s\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)
  )
    return undefined;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f)) return undefined;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length <= 255
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

/** CellData retains stale extended values when reused; only its active flag grants an OSC ID. */
export function terminalOscId(cell: unknown): number | undefined {
  if (!cell) return 0;
  if (!isOscAttributes(cell)) return undefined;
  const flags = cell.hasExtendedAttrs();
  if (typeof flags !== "number") return undefined;
  if (flags === 0) return 0;
  if (!("extended" in cell)) return undefined;
  const value = cell.extended;
  return value && typeof value === "object" && "urlId" in value && typeof value.urlId === "number"
    ? value.urlId
    : undefined;
}
function isOscAttributes(value: unknown): value is { hasExtendedAttrs(): unknown } {
  return (
    !!value &&
    typeof value === "object" &&
    "hasExtendedAttrs" in value &&
    typeof value.hasExtendedAttrs === "function"
  );
}
export function terminalOscTarget(terminal: unknown, id: number): unknown {
  if (!terminal || typeof terminal !== "object" || !("_core" in terminal)) return undefined;
  const core = terminal._core;
  if (!core || typeof core !== "object" || !("_oscLinkService" in core)) return undefined;
  const service = core._oscLinkService;
  if (!isOscService(service)) return undefined;
  const data: unknown = service.getLinkData(id);
  return data && typeof data === "object" && "uri" in data ? data.uri : undefined;
}

function isOscService(value: unknown): value is { getLinkData(id: number): unknown } {
  return (
    !!value &&
    typeof value === "object" &&
    "getLinkData" in value &&
    typeof value.getLinkData === "function"
  );
}
