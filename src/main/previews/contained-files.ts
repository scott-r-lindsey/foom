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

export interface CanonicalRoot {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

/** Canonical worktree root, captured once when the preview opens. */
export function canonicalRoot(root: string): CanonicalRoot {
  const real = fs.realpathSync.native(root);
  const stat = fs.statSync(real, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Preview root is not a directory");
  return { path: real, dev: stat.dev, ino: stat.ino };
}

function targetRefusal(root: string, real: string): Refusal | undefined {
  if (!inside(root, real, path.sep)) return { status: 403, reason: "escape" };
  const relative = path.relative(root, real);
  // Symlinks and replaced ancestors can land on names the URL could not name.
  const parsed = segmentsFor(`/${relative.split(path.sep).map(encodeURIComponent).join("/")}`);
  if ("error" in parsed) return { status: 403, reason: `target-${parsed.error}` };
  return undefined;
}

/**
 * Open a file for one request. Returns `{ status, ... }`. On success the caller
 * owns `fd` and must close it. The file is opened by its resolved real path and
 * checked against its descriptor, post-open target, and captured root identity.
 */
export function openInside(
  root: CanonicalRoot,
  pathname: unknown,
  recordMissing?: (file: string) => void,
): OpenedFile | Refusal {
  const parsed = segmentsFor(pathname);
  if ("error" in parsed) return { status: 400, reason: parsed.error };
  let candidate = path.join(root.path, ...parsed.segments);
  let real: string;
  try {
    real = fs.realpathSync.native(candidate);
    if (!inside(root.path, real, path.sep)) return { status: 403, reason: "escape" };
    if (fs.statSync(real).isDirectory()) {
      candidate = path.join(real, "index.html");
      real = fs.realpathSync.native(candidate);
      if (!inside(root.path, real, path.sep)) return { status: 403, reason: "escape" };
    }
  } catch {
    recordMissing?.(candidate);
    return { status: 404, reason: "missing" };
  }
  const recheck = targetRefusal(root.path, real);
  if (recheck) return recheck;
  let fd: number | undefined;
  try {
    // Check the type first: opening a FIFO or device could block or have effects.
    const named = fs.statSync(real, { bigint: true });
    if (!named.isFile()) return { status: 403, reason: "not-file" };
    // Node does not expose O_NOFOLLOW or O_NONBLOCK on Windows. Use zero for
    // those unavailable flags there; the descriptor type/dev/ino check remains.
    fd = fs.openSync(real, openFlags(fs.constants));
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.ino !== named.ino || stat.dev !== named.dev) {
      fs.closeSync(fd);
      return { status: 403, reason: "not-file" };
    }
    // Linux's fd link names the opened object rather than traversing the request
    // again. Never fall back to a pathname if procfs is missing or inaccessible.
    // Node exposes no equivalent on macOS/Windows: re-resolve, authorize, and
    // compare identity instead. Repeated root flips remain a documented limit.
    const verified =
      process.platform === "linux"
        ? fs.readlinkSync(`/proc/self/fd/${String(fd)}`)
        : fs.realpathSync.native(candidate);
    const refusal = targetRefusal(root.path, verified);
    if (refusal) {
      fs.closeSync(fd);
      return refusal;
    }
    if (process.platform !== "linux") {
      const current = fs.statSync(verified, { bigint: true });
      if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) {
        fs.closeSync(fd);
        return { status: 403, reason: "not-file" };
      }
    }
    const currentRoot = fs.statSync(root.path, { bigint: true });
    if (
      !currentRoot.isDirectory() ||
      currentRoot.dev !== root.dev ||
      currentRoot.ino !== root.ino
    ) {
      fs.closeSync(fd);
      return { status: 403, reason: "escape" };
    }
    real = verified;
    const relative = path.relative(root.path, real);
    const type = contentType(real);
    const limit = fileLimit(type);
    if (stat.size > limit) {
      fs.closeSync(fd);
      return { status: 413, reason: "too-large" };
    }
    return { status: 200, fd, real, relative, size: Number(stat.size), type };
  } catch {
    recordMissing?.(real);
    if (fd !== undefined) fs.closeSync(fd);
    return { status: 404, reason: "unreadable" };
  }
}

export function readInside(
  root: CanonicalRoot,
  pathname: unknown,
  recordMissing?: (file: string) => void,
): ReadFile | Refusal {
  const opened = openInside(root, pathname, recordMissing);
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
  root: CanonicalRoot,
  url: unknown,
  origin: string,
  record?: (file: string) => void,
  network = false,
): (ReadFile | Refusal) & { headers: Record<string, string> } {
  const parsed = pathnameFor(url, origin);
  const result = "pathname" in parsed ? readInside(root, parsed.pathname, record) : parsed;
  if ("pathname" in parsed && (result.status === 200 || result.status === 404)) {
    const segments = segmentsFor(parsed.pathname);
    if ("segments" in segments) record?.(path.join(root.path, ...segments.segments));
    if (result.status === 200) record?.(result.real);
  }
  return {
    ...result,
    headers: responseHeaders(
      result.status === 200 ? result.type : "text/plain; charset=utf-8",
      network,
    ),
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
