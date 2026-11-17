import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ApplicationError } from "../../shared/application-errors";
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

  /** Publish a complete initial file without replacing another profile's file. */
  async createFile(relative: string, content: string): Promise<boolean> {
    if (!(await this.contained(dirname(relative).replace(/^\.$/, ""))))
      throw new Error("A Foom config folder is redirected outside the config folder");
    const temporary = this.path(`.foom-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o644 });
      try {
        await link(temporary, this.path(relative));
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
        throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** All cooperating profiles hold this lock from the settings read through rename. */
  async withSettingsLock<T>(work: () => Promise<T>): Promise<T> {
    return withSettingsLock(this.path(".foom-settings.lock"), work);
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

const settingsBusy = () => new ApplicationError("settings-busy");

async function processIdentity(pid: number): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try {
    const [stat, boot] = await Promise.all([
      readFile(`/proc/${String(pid)}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    // comm may contain spaces and parentheses. Field 22 is the start tick.
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return start ? `${boot.trim()}:${start}` : null;
  } catch {
    return null;
  }
}

function parseLockRecord(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function staleLock(path: string): Promise<string | null> {
  const bytes = await readConfigFile(path).catch(() => {
    throw new ApplicationError("settings-lock-corrupt");
  });
  if (!bytes) return null;
  const text = bytes.toString("utf8");
  const record = parseLockRecord(text);
  if (
    typeof record === "object" &&
    record !== null &&
    "hostname" in record &&
    typeof record.hostname === "string" &&
    record.hostname !== hostname()
  )
    return null;
  if (
    typeof record !== "object" ||
    record === null ||
    !("pid" in record) ||
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    !("hostname" in record) ||
    typeof record.hostname !== "string" ||
    !("token" in record) ||
    typeof record.token !== "string" ||
    !record.token ||
    !("timestamp" in record) ||
    typeof record.timestamp !== "number" ||
    !Number.isFinite(record.timestamp) ||
    !("start" in record) ||
    (record.start !== null && typeof record.start !== "string")
  )
    throw new ApplicationError("settings-lock-corrupt");
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH" ? text : null;
  }
  const identity = await processIdentity(record.pid);
  return record.start !== null && identity !== null && record.start !== identity ? text : null;
}

/** Cleanup must never discard ownership after a successful publication. */
async function cleanupLockTemporary(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EBUSY") &&
        attempt < 4
      ) {
        await sleep(25 * 2 ** attempt);
        continue;
      }
      console.warn(
        "Unable to remove a settings lock temporary file; cleanup will retry on a later acquisition.",
      );
      return;
    }
  }
}

async function sweepLockTemporaries(folder: string): Promise<void> {
  const names = await readdir(folder).catch(() => []);
  for (const name of names) {
    if (!/^\.foom-[0-9a-f-]{36}\.tmp$/u.test(name)) continue;
    const path = join(folder, name);
    // Other config temporaries, partial records and live/foreign owners stay untouched.
    if ((await staleLock(path).catch(() => null)) !== null) await cleanupLockTemporary(path);
  }
}

/** Publish only complete records. Hard links are exclusive on Windows as well as POSIX.
 * Filesystems that refuse hard links fail closed; never fall back to an empty lock.
 */
async function publishLock(path: string, record: string): Promise<boolean> {
  const temporary = join(dirname(path), `.foom-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(record);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOTSUP" || error.code === "EOPNOTSUPP" || error.code === "ENOSYS")
      )
        throw new ApplicationError("settings-lock-unsupported");
      throw error;
    }
  } finally {
    await cleanupLockTemporary(temporary);
  }
}

async function ownsLock(path: string, token: string): Promise<boolean> {
  const bytes = await readConfigFile(path).catch(() => null);
  const record: unknown = bytes ? parseLockRecord(bytes.toString("utf8")) : null;
  return (
    typeof record === "object" && record !== null && "token" in record && record.token === token
  );
}

async function withSettingsLock<T>(path: string, work: () => Promise<T>, depth = 0): Promise<T> {
  await sweepLockTemporaries(dirname(path));
  const token = randomUUID();
  const record = JSON.stringify({
    pid: process.pid,
    start: await processIdentity(process.pid),
    hostname: hostname(),
    token,
    timestamp: Date.now(),
  });
  for (let attempt = 0; ; attempt++) {
    if (await publishLock(path, record)) {
      try {
        if (!(await ownsLock(path, token))) throw settingsBusy();
        return await work();
      } finally {
        if (await ownsLock(path, token)) await rm(path);
      }
    }
    const stale = await staleLock(path);
    if (stale !== null && depth < 4) {
      // Serialize the compare/remove, not just the later exclusive create. A
      // crashed recovery owner is recovered by the same protocol one level down.
      await withSettingsLock(
        `${path}.recovery`,
        async () => {
          if ((await staleLock(path)) === stale) await rm(path, { force: true });
        },
        depth + 1,
      );
    }
    if (attempt === 20) throw settingsBusy();
    await sleep(25);
  }
}
