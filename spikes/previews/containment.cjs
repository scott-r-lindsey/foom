"use strict";
// Resolve a foom-preview:// URL path to a regular file inside one worktree.
// Pure policy is separated from filesystem access so the Windows rules can be
// unit-tested on any platform; the filesystem half runs on the host platform.

const fs = require("node:fs");
const path = require("node:path");

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const MAX_SEGMENTS = 64;
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
 * refusal reason. `platform` selects the stricter Windows name rules.
 */
function segmentsFor(pathname, platform = process.platform) {
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
    if (/[\u0000-\u001f\u007f]/.test(segment)) return { error: "control" };
    if (platform === "win32") {
      // Drive letters, alternate data streams, trailing dot/space aliases and
      // device names all map one string onto a different file on Windows.
      if (segment.includes(":")) return { error: "windows-colon" };
      if (/[. ]$/.test(segment)) return { error: "windows-trailing" };
      if (WINDOWS_DEVICE.test(segment)) return { error: "windows-device" };
      if (/[<>"|?*]/.test(segment)) return { error: "windows-reserved" };
    }
    segments.push(segment);
  }
  return { segments, directory: raw.at(-1) === "" };
}

function contentType(file) {
  return TYPES.get(path.extname(file).toLowerCase()) ?? "application/octet-stream";
}

function inside(root, real) {
  // Both sides come from realpath; never case-fold. A case-insensitive volume
  // can only cause a false refusal here, never an escape.
  return real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Canonical worktree root, captured once when the preview opens. */
function canonicalRoot(root) {
  const real = fs.realpathSync.native(root);
  if (!fs.statSync(real).isDirectory()) throw new Error("Preview root is not a directory");
  return real;
}

/**
 * Open a file for one request. Returns `{ status, ... }`. On success the caller
 * owns `fd` and must close it. The file is opened by its resolved real path and
 * re-checked by descriptor so a swapped final component cannot redirect it.
 */
function openInside(root, pathname, options = {}) {
  const platform = options.platform ?? process.platform;
  const parsed = segmentsFor(pathname, platform);
  if (parsed.error) return { status: 400, reason: parsed.error };
  let candidate = path.join(root, ...parsed.segments);
  let real;
  try {
    real = fs.realpathSync.native(candidate);
    if (!inside(root, real)) return { status: 403, reason: "escape" };
    if (fs.statSync(real).isDirectory()) {
      candidate = path.join(real, "index.html");
      real = fs.realpathSync.native(candidate);
      if (!inside(root, real)) return { status: 403, reason: "escape" };
    }
  } catch {
    return { status: 404, reason: "missing" };
  }
  const relative = path.relative(root, real);
  // A symlink may land on hidden or reserved names that the URL could not name.
  const recheck = segmentsFor(`/${relative.split(path.sep).map(encodeURIComponent).join("/")}`, platform);
  if (recheck.error) return { status: 403, reason: `target-${recheck.error}` };
  let fd;
  try {
    // Check the type first: opening a FIFO or device could block or have effects.
    const named = fs.statSync(real);
    if (!named.isFile()) return { status: 403, reason: "not-file" };
    const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
    fd = fs.openSync(real, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.ino !== named.ino || stat.dev !== named.dev) {
      fs.closeSync(fd);
      return { status: 403, reason: "not-file" };
    }
    const type = contentType(real);
    const limit = type.startsWith("text/markdown")
      ? (options.maxMarkdownBytes ?? MAX_MARKDOWN_BYTES)
      : (options.maxBytes ?? MAX_FILE_BYTES);
    if (stat.size > limit) {
      fs.closeSync(fd);
      return { status: 413, reason: "too-large" };
    }
    return { status: 200, fd, real, relative, size: stat.size, type };
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    return { status: 404, reason: "unreadable" };
  }
}

function readInside(root, pathname, options) {
  const opened = openInside(root, pathname, options);
  if (opened.status !== 200) return opened;
  try {
    const body = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const read = fs.readSync(opened.fd, body, offset, opened.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return { ...opened, fd: undefined, body: body.subarray(0, offset) };
  } finally {
    fs.closeSync(opened.fd);
  }
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_MARKDOWN_BYTES,
  canonicalRoot,
  contentType,
  inside,
  openInside,
  readInside,
  segmentsFor,
};
