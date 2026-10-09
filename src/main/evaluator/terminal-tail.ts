/** Likely-secret redaction, not a guarantee for arbitrary unlabelled secrets. */
export function prepareTail(tail: readonly string[]): string {
  const raw = tail.join("\n").replace(/\r\n?/g, "\n");
  if (raw.length > 131_072) throw new Error("Tail too large");
  // The host may already have removed either PEM marker when selecting its tail.
  // Preserve physical lines throughout redaction so trimming never expands that boundary.
  const redacted = raw
    .split("")
    .filter(
      (char) =>
        char === "\n" || char === "\t" || (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    )
    .join("")
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      redactPrivateKey,
    )
    // An unmatched END proves the preceding tail may begin inside a private key.
    // Conservatively remove the whole prefix, including nonstandard PEM body lines.
    .replace(/^[\s\S]*-----END [A-Z ]*PRIVATE KEY-----/, redactPrivateKey)
    // With neither marker available, suppress leading PEM-sized base64 lines and
    // their optional short final line. Arbitrary unlabelled secrets remain heuristic.
    .replace(
      /^(?:[A-Za-z0-9+/]{64,}[ \t]*(?:\n|$))+(?:[A-Za-z0-9+/]+={0,2}[ \t]*(?:\n|$))?/,
      redactPrivateKey,
    )
    .replace(
      /(?:\b(?:[a-z0-9_-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)|authorization|cookie|set-cookie)\b["']?[ \t]*[:=][ \t]*)[^\s\n][^\n]*/gi,
      "[REDACTED CREDENTIAL]",
    )
    .replace(/\bBearer[ \t]+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AIza[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
      "[REDACTED TOKEN]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED JWT]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/gi, "[REDACTED URL CREDENTIALS]@");
  return redacted.split("\n").slice(-40).join("\n");
}

function redactPrivateKey(block: string): string {
  return block.replace(/[^\n]+/g, "[REDACTED PRIVATE KEY]");
}
