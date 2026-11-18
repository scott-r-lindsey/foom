import { validImage } from "./image";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FileHandle } from "node:fs/promises";
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
  handle: FileHandle;
  real: string;
  relative: string;
  size: number;
  type: string;
}
export type ReadFile = Omit<OpenedFile, "handle"> & { body: Buffer };

export interface CanonicalRoot {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

/** Canonical directory root, captured once when the preview opens. */
export function canonicalRoot(root: string): CanonicalRoot {
  const real = fs.realpathSync.native(root);
  const stat = fs.statSync(real, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Preview root is not a directory");
  return { path: real, dev: stat.dev, ino: stat.ino };
}

export function documentWithin(directory: string, document: string): boolean {
  const child = path.relative(directory, document);
  return child !== ".." && !child.startsWith(`..${path.sep}`) && !path.isAbsolute(child);
}

const DOCUMENT_EXTENSION = /\.(md|markdown|html|htm|png|jpe?g|webp)$/i;

export function documentPathname(relative: string): string {
  return `/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

const execute = promisify(execFile);

function gitAt(directory: string, gitDir: "." | ".git", ...query: string[]) {
  return execute(
    "git",
    ["-C", directory, `--git-dir=${gitDir}`, "-c", "core.fsmonitor=false", "rev-parse", ...query],
    {
      cwd: path.dirname(process.execPath),
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
        ),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: 5000,
      maxBuffer: 16 * 1024,
      encoding: "utf8",
      windowsHide: true,
    },
  );
}

async function entryExists(entry: string): Promise<boolean> {
  try {
    await fs.promises.lstat(entry);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function captureDirectory(directory: string): Promise<CanonicalRoot> {
  const stat = await fs.promises.lstat(directory, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Preview root is not a directory");
  return { path: directory, dev: stat.dev, ino: stat.ino };
}

async function nearestCheckoutCandidate(directory: string): Promise<CanonicalRoot | undefined> {
  for (let current = directory; ; current = path.dirname(current)) {
    // Anchor identity before inspecting metadata. A .git symlink is still an entry.
    const candidate = await captureDirectory(current);
    if (await entryExists(path.join(current, ".git"))) return candidate;
    // Check the metadata layout without reading config that could hide a bare repository.
    if (await entryExists(path.join(current, "HEAD"))) {
      const repository = await gitAt(current, ".", "--resolve-git-dir", ".").catch(
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === 128) return undefined;
          throw error;
        },
      );
      if (repository) return undefined;
    }
    if (path.dirname(current) === current) return undefined;
  }
}

async function previewRoot(directory: string): Promise<CanonicalRoot> {
  const canonical = fs.realpathSync.native(directory);
  try {
    const candidate = await nearestCheckoutCandidate(canonical);
    if (candidate) {
      const { stdout } = await gitAt(candidate.path, ".git", "--show-toplevel");
      const top = stdout.replace(/\r?\n$/, "");
      // Compare Git's answer without following a path supplied by repository config.
      if (
        path.isAbsolute(top) &&
        !/[\p{Cc}\p{Cs}]/u.test(top) &&
        path.relative(candidate.path, top) === ""
      ) {
        const current = await captureDirectory(candidate.path);
        if (candidate.dev === current.dev && candidate.ino === current.ino) return candidate;
      }
    }
  } catch {
    // Standalone files remain usable when Git is unavailable or rejects discovery.
  }
  return captureDirectory(canonical);
}

/** Resolve the document before selecting the scope of its browser origin. */
export async function resolveDocument(
  file: string,
  preserveAlias = false,
): Promise<
  { status: 200; root: CanonicalRoot; real: string; relative: string; type: string } | Refusal
> {
  if (
    !path.isAbsolute(file) ||
    file.length > 4096 ||
    /[\p{Cc}\p{Cs}]/u.test(file) ||
    (process.platform === "win32" &&
      (/^[\\/]{2}[?.][\\/]/.test(file) ||
        (!path.parse(file).root.includes(":") && !/^[\\/]{2}/.test(file)))) ||
    !DOCUMENT_EXTENSION.test(file)
  )
    return { status: 400, reason: "invalid-path" };
  const named = segmentsFor(documentPathname(path.basename(file)));
  if ("error" in named) return { status: 403, reason: named.error };
  const forbiddenAncestor = (absolute: string) =>
    absolute
      .slice(path.parse(absolute).root.length)
      .split(path.sep)
      .some(
        (name) =>
          name.toLowerCase() === "__foom__" ||
          (process.platform === "win32" && /:|[. ]$/.test(name)),
      );
  if (forbiddenAncestor(file)) return { status: 403, reason: "reserved" };

  let root: CanonicalRoot;
  let real: string;
  try {
    real = await fs.promises.realpath(file);
    if (forbiddenAncestor(real)) return { status: 403, reason: "reserved" };
    if (!(await fs.promises.stat(real)).isFile()) return { status: 403, reason: "not-file" };
    root = await previewRoot(path.dirname(real));
  } catch {
    return { status: 404, reason: "unreadable" };
  }
  // An in-root picker alias remains watchable and may be retargeted in that root.
  const entry = preserveAlias && documentWithin(root.path, file) ? file : real;
  const relative = path.relative(root.path, entry).split(path.sep).join("/");
  const opened = await openDocument(root, documentPathname(relative));
  if (opened.status !== 200) return opened;
  try {
    if (opened.real !== real || (await fs.promises.realpath(file)) !== real)
      return { status: 403, reason: "changed" };
  } catch {
    return { status: 404, reason: "unreadable" };
  }
  if (/\.(png|jpe?g|webp)$/i.test(file) && !opened.type.startsWith("image/"))
    return { status: 400, reason: "invalid-image" };
  return { status: 200, root, real, relative, type: opened.type };
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
 * owns `handle` and must close it. The file is opened by its resolved real path and
 * checked against its descriptor, post-open target, and captured root identity.
 */
export async function openInside(
  root: CanonicalRoot,
  pathname: unknown,
  recordMissing?: (file: string) => void,
): Promise<OpenedFile | Refusal> {
  const parsed = segmentsFor(pathname);
  if ("error" in parsed) return { status: 400, reason: parsed.error };
  let candidate = path.join(root.path, ...parsed.segments);
  let real: string;
  try {
    real = await fs.promises.realpath(candidate);
    if (!inside(root.path, real, path.sep)) return { status: 403, reason: "escape" };
    if ((await fs.promises.stat(real)).isDirectory()) {
      candidate = path.join(real, "index.html");
      real = await fs.promises.realpath(candidate);
      if (!inside(root.path, real, path.sep)) return { status: 403, reason: "escape" };
    }
  } catch {
    recordMissing?.(candidate);
    return { status: 404, reason: "missing" };
  }
  const recheck = targetRefusal(root.path, real);
  if (recheck) return recheck;
  let handle: FileHandle | undefined;
  let transferred = false;
  try {
    // Check the type first: opening a FIFO or device could block or have effects.
    const named = await fs.promises.stat(real, { bigint: true });
    if (!named.isFile()) return { status: 403, reason: "not-file" };
    // Node does not expose O_NOFOLLOW or O_NONBLOCK on Windows. Use zero for
    // those unavailable flags there; the descriptor type/dev/ino check remains.
    handle = await fs.promises.open(real, openFlags(fs.constants));
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.ino !== named.ino || stat.dev !== named.dev) {
      return { status: 403, reason: "not-file" };
    }
    // Linux's fd link names the opened object rather than traversing the request
    // again. Never fall back to a pathname if procfs is missing or inaccessible.
    // Node exposes no equivalent on macOS/Windows: re-resolve, authorize, and
    // compare identity instead. Repeated root flips remain a documented limit.
    const verified =
      process.platform === "linux"
        ? await fs.promises.readlink(`/proc/self/fd/${String(handle.fd)}`)
        : await fs.promises.realpath(candidate);
    const refusal = targetRefusal(root.path, verified);
    if (refusal) {
      return refusal;
    }
    if (process.platform !== "linux") {
      const current = await fs.promises.stat(verified, { bigint: true });
      if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) {
        return { status: 403, reason: "not-file" };
      }
    }
    const currentRoot = await fs.promises.stat(root.path, { bigint: true });
    if (
      !currentRoot.isDirectory() ||
      currentRoot.dev !== root.dev ||
      currentRoot.ino !== root.ino
    ) {
      return { status: 403, reason: "escape" };
    }
    real = verified;
    const relative = path.relative(root.path, real);
    const type = contentType(real);
    const limit = fileLimit(type);
    if (stat.size > limit) {
      return { status: 413, reason: "too-large" };
    }
    transferred = true;
    return { status: 200, handle, real, relative, size: Number(stat.size), type };
  } catch {
    recordMissing?.(real);
    return { status: 404, reason: "unreadable" };
  } finally {
    if (!transferred) await handle?.close();
  }
}

export async function readInside(
  root: CanonicalRoot,
  pathname: unknown,
  recordMissing?: (file: string) => void,
): Promise<ReadFile | Refusal> {
  const opened = await openInside(root, pathname, recordMissing);
  if (opened.status !== 200) return opened;
  return readOpened(opened);
}

async function readOpened(opened: OpenedFile): Promise<ReadFile> {
  try {
    const body = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead: read } = await opened.handle.read({
        buffer: body,
        offset,
        length: opened.size - offset,
        position: offset,
      });
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
    await opened.handle.close();
  }
}

/** Session-independent request adapter. No protocol or scheme is registered here. */
export async function readPreview(
  root: CanonicalRoot,
  url: unknown,
  origin: string,
  record?: (file: string) => void,
  network = false,
): Promise<(ReadFile | Refusal) & { headers: Record<string, string> }> {
  const parsed = pathnameFor(url, origin);
  const result = "pathname" in parsed ? await readInside(root, parsed.pathname, record) : parsed;
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

/** Entry validation retains the contained descriptor checks and bounds image decoding. */
export async function openDocument(
  root: CanonicalRoot,
  pathname: string,
): Promise<Omit<OpenedFile, "handle"> | Refusal> {
  const opened = await openInside(root, pathname);
  if (opened.status !== 200) return opened;
  if (/\.(png|jpe?g|webp)$/i.test(pathname) && !/^image\/(png|jpeg|webp)$/.test(opened.type)) {
    await opened.handle.close();
    return { status: 400, reason: "invalid-image" };
  }
  if (!/^(text\/(html|markdown);|image\/(png|jpeg|webp)$)/.test(opened.type)) {
    await opened.handle.close();
    return { status: 400, reason: "unsupported-type" };
  }
  if (/^image\/(png|jpeg|webp)$/.test(opened.type)) {
    const image = await readOpened(opened);
    if (!(await validImage(image.body, image.type)))
      return { status: 400, reason: "invalid-image" };
    return image;
  }
  const { handle, ...metadata } = opened;
  await handle.close();
  return metadata;
}
