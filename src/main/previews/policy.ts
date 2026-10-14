export type SegmentResult = { error: string } | { segments: string[]; directory: boolean };
export type Refusal = { status: 400 | 403 | 404 | 413; reason: string };

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
export const MAX_SEGMENTS = 64;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

const TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".markdown", "text/markdown; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json"],
  [".txt", "text/plain; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
]);

/**
 * Split an already URL-normalized pathname into safe segments, or return a
 * refusal reason. Windows filename rules apply on every host platform.
 */
export function segmentsFor(pathname: unknown): SegmentResult {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return { error: "not-absolute" };
  const raw = pathname.split("/").slice(1);
  if (raw.length > MAX_SEGMENTS) return { error: "too-deep" };
  const segments = [];
  for (const [index, encoded] of raw.entries()) {
    if (encoded === "" && index === raw.length - 1) break; // trailing slash: directory
    let segment;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return { error: "bad-encoding" };
    }
    if (segment === "" || segment === "." || segment === "..") return { error: "dot-segment" };
    if (/[/\\\0]/.test(segment)) return { error: "separator" };
    // Hidden names cover .git, .env and editor state; agents rarely link to them.
    if (segment.startsWith(".")) return { error: "hidden" };
    // Control characters are never part of a page an agent means to show.
    if (
      Array.from(segment).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      return { error: "control" };
    // Drive letters, alternate data streams, trailing dot/space aliases and
    // device names all map one string onto a different file on Windows.
    if (segment.includes(":")) return { error: "windows-colon" };
    if (/[. ]$/.test(segment)) return { error: "windows-trailing" };
    if (WINDOWS_DEVICE.test(segment)) return { error: "windows-device" };
    if (/[<>"|?*]/.test(segment)) return { error: "windows-reserved" };
    if (segment.toLowerCase() === "__foom__") return { error: "reserved" };
    segments.push(segment);
  }
  return { segments, directory: raw.at(-1) === "" };
}

export function contentType(file: string): string {
  return TYPES.get(file.slice(file.lastIndexOf(".")).toLowerCase()) ?? "application/octet-stream";
}

/** Normalize as a standard URL before decoding individual path segments. */
export function pathnameFor(input: unknown, origin: string): { pathname: string } | Refusal {
  if (typeof input !== "string") return { status: 400, reason: "bad-url" };
  try {
    const url = new URL(input);
    if (
      url.protocol !== "foom-preview:" ||
      `foom-preview://${url.host}` !== origin ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== ""
    ) {
      return { status: 403, reason: "origin" };
    }
    return { pathname: url.pathname };
  } catch {
    return { status: 400, reason: "bad-url" };
  }
}

export function inside(root: string, real: string, separator: string): boolean {
  // Canonical paths are compared byte for byte, never case-folded.
  return real === root || real.startsWith(root.endsWith(separator) ? root : root + separator);
}

export function fileLimit(type: string): number {
  return type.startsWith("text/markdown") ? MAX_MARKDOWN_BYTES : MAX_FILE_BYTES;
}

export const HTML_CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";
export const MARKDOWN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function externalLink(url: string): boolean {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function previewCsp(type: string, network: boolean): string {
  const policy = type.startsWith("text/markdown") ? MARKDOWN_CSP : HTML_CSP;
  if (!network) return policy;
  const sources = new Set([
    "default-src",
    "script-src",
    "style-src",
    "img-src",
    "font-src",
    "media-src",
    "worker-src",
    "frame-src",
  ]);
  const directives = policy.split("; ").map((directive) => {
    const name = directive.split(" ")[0] ?? "";
    if (name === "connect-src") return `${directive} https: wss:`;
    return sources.has(name) && !directive.includes("'none'") ? `${directive} https:` : directive;
  });
  if (!directives.some((directive) => directive.startsWith("connect-src ")))
    directives.push("connect-src 'self' https: wss:");
  return directives.join("; ");
}

export function responseHeaders(type: string, network = false): Record<string, string> {
  return {
    "content-type": type,
    "content-security-policy": previewCsp(type, network),
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  };
}
