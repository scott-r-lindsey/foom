import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ThemeValidationError } from "../../shared/theme-validation";
import type { ConfigServiceDependencies } from "./service";

const MAX_FILE = 65536;

/** Rejections that only mean "unavailable"; the caller falls back. */
export const ignore = (): undefined => undefined;
export async function settle<T, F>(promise: Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

/** Reads a direct regular file without following links; null when it does not exist. */
async function readConfigFile(path: string): Promise<Buffer | null> {
  const before = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new ThemeValidationError("$", "unreadable");
  });
  if (!before) return null;
  if (!before.isFile()) throw new ThemeValidationError("$", "unsafe-file");
  if (before.size > MAX_FILE) throw new ThemeValidationError("$", "too-large");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new ThemeValidationError("$", "unsafe-file");
  });
  try {
    const info = await file.stat();
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev)
      throw new ThemeValidationError("$", "unsafe-file");
    const bytes = Buffer.alloc(MAX_FILE + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_FILE) throw new ThemeValidationError("$", "too-large");
    return bytes.subarray(0, count);
  } finally {
    await file.close();
  }
}

export function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ThemeValidationError("$", "malformed-json");
  }
}

/** Contained config reads and atomic writes; approval remains in ConfigService. */
export class ConfigFiles {
  constructor(
    private readonly deps: Pick<ConfigServiceDependencies, "root" | "platform" | "rename">,
  ) {}

  path(relative: string): string {
    return join(this.deps.root, ...relative.split("/"));
  }

  /**
   * Whether a folder inside the config root is a real directory at its expected place.
   * `O_NOFOLLOW` guards only the last path component, so a `themes` link to another
   * directory must be refused before reading, writing or removing anything in it.
   */
  async contained(folder: string): Promise<boolean> {
    if (!folder) return true;
    try {
      const info = await lstat(this.path(folder));
      if (!info.isDirectory()) return false;
      const root = await realpath(this.deps.root);
      return (await realpath(this.path(folder))) === join(root, ...folder.split("/"));
    } catch {
      return false;
    }
  }

  async read(relative: string): Promise<Buffer | null> {
    if (!(await this.contained(dirname(relative).replace(/^\.$/, ""))))
      throw new ThemeValidationError("$", "unsafe-file");
    return readConfigFile(this.path(relative));
  }

  /** Atomic replacement inside the folder; the temporary name is hidden from the catalogs. */
  async writeFile(relative: string, content: Uint8Array | string): Promise<void> {
    const target = this.path(relative);
    await mkdir(dirname(target), { recursive: true });
    if (!(await this.contained(dirname(relative).replace(/^\.$/, ""))))
      throw new Error("A Foom config folder is redirected outside the config folder");
    const temporary = join(dirname(target), `.foom-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o644 });
      // Windows scanners can briefly deny replacement even after our readers close.
      // Five attempts, at most 375 ms of backoff; never unlink the existing target.
      for (let attempt = 0; ; attempt++) {
        try {
          await (this.deps.rename ?? rename)(temporary, target);
          break;
        } catch (error) {
          if (
            (this.deps.platform ?? process.platform) !== "win32" ||
            !(error instanceof Error) ||
            !("code" in error) ||
            (error.code !== "EPERM" && error.code !== "EBUSY") ||
            attempt === 4
          )
            throw new Error(`Unable to replace ${relative}. The change was not applied.`, {
              cause: error,
            });
          await sleep(25 * 2 ** attempt);
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
