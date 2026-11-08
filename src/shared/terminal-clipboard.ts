/** Maximum decoded UTF-8 bytes per OSC 52 clipboard replacement. */
export const MAX_TERMINAL_CLIPBOARD_BYTES = 65_536;
const MAX_PAYLOAD = 2 + 4 * Math.ceil(MAX_TERMINAL_CLIPBOARD_BYTES / 3);

/** Untrusted OSC 52 body. Only default/explicit clipboard, never primary or queries. */
export function terminalClipboardText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_PAYLOAD) return undefined;
  const separator = value.indexOf(";");
  if (separator < 0 || (value.slice(0, separator) !== "" && value.slice(0, separator) !== "c"))
    return undefined;
  const encoded = value.slice(separator + 1);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?|)$/u.test(encoded))
    return undefined;
  try {
    const binary = atob(encoded);
    if (
      binary.length > MAX_TERMINAL_CLIPBOARD_BYTES ||
      btoa(binary).replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")
    )
      return undefined;
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return undefined;
  }
}
