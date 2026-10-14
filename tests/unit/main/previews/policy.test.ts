import { expect, test } from "vitest";
import {
  contentType,
  fileLimit,
  HTML_CSP,
  inside,
  MARKDOWN_CSP,
  MAX_FILE_BYTES,
  MAX_MARKDOWN_BYTES,
  pathnameFor,
  responseHeaders,
  segmentsFor,
} from "../../../../src/main/previews/policy";

test("normalizes URL dot segments and confines the origin", () => {
  for (const raw of [
    "/../../etc/hostname",
    "/docs/../../../etc/hostname",
    "/%2e%2e/%2E%2E/etc/hostname",
    "/.%2e/etc/hostname",
  ]) {
    expect(pathnameFor(`foom-preview://id${raw}`, "foom-preview://id")).toEqual({
      pathname: "/etc/hostname",
    });
  }
  for (const url of [null, {}, 3, "relative", "http://["])
    expect(pathnameFor(url, "foom-preview://id")).toEqual({ status: 400, reason: "bad-url" });
  for (const url of [
    "https://id/a",
    "foom-preview://other/a",
    "foom-preview://user:pass@id/a",
    "foom-preview://id:80/a",
  ])
    expect(pathnameFor(url, "foom-preview://id")).toEqual({ status: 403, reason: "origin" });
  expect(pathnameFor("foom-preview://id/a%20b?x=1#hash", "foom-preview://id")).toEqual({
    pathname: "/a%20b",
  });
});

test("refuses hostile segments including Windows aliases on every OS", () => {
  const cases: Record<string, string> = {
    relative: "not-absolute",
    "/a//b": "dot-segment",
    "/./a": "dot-segment",
    "/../a": "dot-segment",
    "/..%2f..%2fetc%2fhostname": "separator",
    "/..%5c..%5cetc%5chostname": "separator",
    "/a%00b": "separator",
    "/docs%2fpage.html": "separator",
    "/.env": "hidden",
    "/.git/config": "hidden",
    "/bad%E0%A4%A": "bad-encoding",
    "/a%0ab": "control",
    "/a%7Fb": "control",
    "/C:/Windows/win.ini": "windows-colon",
    "/page.html::$DATA": "windows-colon",
    "/page.html.": "windows-trailing",
    "/page.html%20": "windows-trailing",
    "/CON": "windows-device",
    "/nul.txt": "windows-device",
    "/COM1.md": "windows-device",
    "/LPT%C2%B3.txt": "windows-device",
    "/CONIN$": "windows-device",
    "/conout$.txt": "windows-device",
    "/a%3Fb": "windows-reserved",
    "/a%3Cb": "windows-reserved",
    "/a%3Eb": "windows-reserved",
    "/a%22b": "windows-reserved",
    "/a%7Cb": "windows-reserved",
    "/a*b": "windows-reserved",
    "/%5C%5C%3F%5CC%3A%5Cx": "separator",
    "/%5C%5Cserver%5Cshare": "separator",
    "/C%3A%5CWindows": "separator",
  };
  for (const [input, error] of Object.entries(cases))
    expect(segmentsFor(input), input).toEqual({ error });
  expect(segmentsFor(undefined)).toEqual({ error: "not-absolute" });
  expect(segmentsFor(`/${"a/".repeat(65)}`)).toEqual({ error: "too-deep" });
  expect(segmentsFor(`/${Array.from({ length: 64 }, () => "a").join("/")}`)).toHaveProperty(
    "segments",
  );
  expect(segmentsFor("/docs/a%20b.html/")).toEqual({
    segments: ["docs", "a b.html"],
    directory: true,
  });
  expect(segmentsFor("/")).toEqual({ segments: [], directory: true });
  expect(segmentsFor("/a%252fb")).toEqual({ segments: ["a%2fb"], directory: false });
});

test("compares canonical roots byte for byte with a separator boundary", () => {
  expect(inside("/tree", "/tree", "/")).toBe(true);
  expect(inside("/tree/", "/tree/x", "/")).toBe(true);
  expect(inside("/tree", "/tree/x", "/")).toBe(true);
  for (const real of ["/TREE/x", "/tree-evil/x", "/other"])
    expect(inside("/tree", real, "/")).toBe(false);
  expect(inside("C:\\tree", "C:\\tree\\x", "\\")).toBe(true);
  expect(inside("C:\\tree", "c:\\tree\\x", "\\")).toBe(false);
});

test("uses a fixed MIME map, byte limits and restrictive response headers", () => {
  const types: Record<string, string[]> = {
    "text/html; charset=utf-8": ["html", "htm"],
    "text/markdown; charset=utf-8": ["md", "markdown"],
    "text/css; charset=utf-8": ["css"],
    "text/javascript; charset=utf-8": ["js", "mjs"],
    "application/json": ["json"],
    "text/plain; charset=utf-8": ["txt"],
    "image/svg+xml": ["svg"],
    "image/png": ["png"],
    "image/jpeg": ["jpg", "jpeg"],
    "image/gif": ["gif"],
    "image/webp": ["webp"],
    "image/avif": ["avif"],
    "image/x-icon": ["ico"],
    "font/woff": ["woff"],
    "font/woff2": ["woff2"],
    "font/ttf": ["ttf"],
    "font/otf": ["otf"],
    "video/mp4": ["mp4"],
    "video/webm": ["webm"],
    "audio/mpeg": ["mp3"],
    "audio/wav": ["wav"],
  };
  for (const [type, extensions] of Object.entries(types))
    for (const ext of extensions) expect(contentType(`a.${ext.toUpperCase()}`)).toBe(type);
  for (const name of ["file", "file.unknown", "file.md.exe"])
    expect(contentType(name)).toBe("application/octet-stream");
  expect(fileLimit(contentType("a.md"))).toBe(2 * 1024 * 1024);
  expect(fileLimit(contentType("a.txt"))).toBe(16 * 1024 * 1024);
  expect(MAX_MARKDOWN_BYTES).toBe(2 * 1024 * 1024);
  expect(MAX_FILE_BYTES).toBe(16 * 1024 * 1024);
  expect(responseHeaders(contentType("a.html"))).toEqual({
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": HTML_CSP,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  expect(responseHeaders(contentType("a.md"))["content-security-policy"]).toBe(MARKDOWN_CSP);
  expect(HTML_CSP).toBe(
    "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
  );
  expect(MARKDOWN_CSP).toBe(
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
});

test("network policy adds secure sources without weakening navigation or script restrictions", async () => {
  const { externalLink, previewCsp } = await import("../../../../src/main/previews/policy");
  for (const url of ["https://example.com", "http://example.com", "mailto:a@example.com"])
    expect(externalLink(url)).toBe(true);
  for (const url of ["garbage", "file:///a", "javascript:alert(1)", "data:text/plain,x"])
    expect(externalLink(url)).toBe(false);
  for (const type of ["text/html", "text/markdown"]) {
    const policy = previewCsp(type, true);
    expect(policy).toContain("connect-src 'self' https: wss:");
    expect(policy).toContain("img-src 'self' data:");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain(" http:");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(responseHeaders(type, true)["content-security-policy"]).toBe(policy);
  }
});
