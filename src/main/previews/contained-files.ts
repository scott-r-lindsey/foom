import fs from "node:fs";
import path from "node:path";
import {
  contentType,
  fileLimit,
  inside,
  pathnameFor,
  responseHeaders,
  segmentsFor,
  type Refusal,
} from "./policy";

export interface OpenedFile {
  status: 200;
  fd: number;
  real: string;
  relative: string;
  size: number;
  type: string;
}
export type ReadFile = Omit<OpenedFile, "fd"> & { body: Buffer };

/** Canonical worktree root, captured once when the preview opens. */
export function canonicalRoot(root: string): string {
  const real = fs.realpathSync.native(root);
  if (!fs.statSync(real).isDirectory()) throw new Error("Preview root is not a directory");
  return real;
}

/**
 * Open a file for one request. Returns `{ status, ... }`. On success the caller
 * owns `fd` and must close it. The file is opened by its resolved real path and
 * re-checked by descriptor so a swapped final component cannot redirect it.
 */
export function openInside(root: string, pathname: unknown): OpenedFile | Refusal {
  const parsed = segmentsFor(pathname);
  if ("error" in parsed) return { status: 400, reason: parsed.error };
  let candidate = path.join(root, ...parsed.segments);
  let real: string;
  try {
    real = fs.realpathSync.native(candidate);
    if (!inside(root, real, path.sep)) return { status: 403, reason: "escape" };
    if (fs.statSync(real).isDirectory()) {
      candidate = path.join(real, "index.html");
      real = fs.realpathSync.native(candidate);
      if (!inside(root, real, path.sep)) return { status: 403, reason: "escape" };
    }
  } catch {
    return { status: 404, reason: "missing" };
  }
  const relative = path.relative(root, real);
  // A symlink may land on hidden or reserved names that the URL could not name.
  const recheck = segmentsFor(`/${relative.split(path.sep).map(encodeURIComponent).join("/")}`);
  if ("error" in recheck) return { status: 403, reason: `target-${recheck.error}` };
  let fd: number | undefined;
  try {
    // Check the type first: opening a FIFO or device could block or have effects.
    const named = fs.statSync(real);
    if (!named.isFile()) return { status: 403, reason: "not-file" };
    // Node does not expose O_NOFOLLOW or O_NONBLOCK on Windows. Use zero for
    // those unavailable flags there; the descriptor type/dev/ino check remains.
    fd = fs.openSync(real, openFlags(fs.constants));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.ino !== named.ino || stat.dev !== named.dev) {
      fs.closeSync(fd);
      return { status: 403, reason: "not-file" };
    }
    const type = contentType(real);
    const limit = fileLimit(type);
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

export function readInside(root: string, pathname: unknown): ReadFile | Refusal {
  const opened = openInside(root, pathname);
  if (opened.status !== 200) return opened;
  try {
    const body = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const read = fs.readSync(opened.fd, body, offset, opened.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return {
      status: 200,
      real: opened.real,
      relative: opened.relative,
      size: offset,
      type: opened.type,
      body: body.subarray(0, offset),
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

/** Session-independent request adapter. No protocol or scheme is registered here. */
export function readPreview(
  root: string,
  url: unknown,
  origin: string,
): (ReadFile | Refusal) & { headers: Record<string, string> } {
  const parsed = pathnameFor(url, origin);
  const result = "pathname" in parsed ? readInside(root, parsed.pathname) : parsed;
  return {
    ...result,
    headers: responseHeaders(result.status === 200 ? result.type : "text/plain; charset=utf-8"),
  };
}

/** Node's declarations list POSIX flags even where the runtime omits them. */
export function openFlags(constants: {
  O_RDONLY: number;
  O_NOFOLLOW?: number;
  O_NONBLOCK?: number;
}): number {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
}
