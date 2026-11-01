import { constants } from "node:fs";
import { open, opendir, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { HostPlatform } from "./host-platform.d";

/** procfs reports size zero; read at most limit + 1 bytes rather than trusting st_size. */
async function boundedRead(path: string, limit: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error("Invalid host observation");
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      signal.throwIfAborted();
      const result = await file.read(bytes, size, bytes.length - size, null);
      signal.throwIfAborted();
      if (!result.bytesRead) return bytes.subarray(0, size);
      size += result.bytesRead;
    }
    throw new Error("Host observation too large");
  } finally {
    await file.close();
  }
}

function startTime(bytes: Buffer, pid: string): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // comm may contain spaces, parentheses and newlines. Fields follow its LAST ')'.
  const match = /^(\d+) \(([\s\S]*)\) ([RSDZTWtXxKPI]) ((?:-?\d+ )*-?\d+)\n$/u.exec(text);
  const fields = match?.[4]?.split(" ");
  const started = fields?.[18]; // field 22; numeric fields begin with ppid (field 4).
  if (
    match?.[1] !== pid ||
    text.includes("\0") ||
    !started ||
    !/^(?:0|[1-9]\d{0,19})$/u.test(started) ||
    BigInt(started) > 18446744073709551615n
  )
    throw new Error("Legacy daemon identity unavailable");
  return started;
}

/** The root/uid parameters allow fixture proc trees on every CI platform. */
export function linuxHostPlatform(root = "/proc", uid = process.getuid?.()): HostPlatform {
  const observe = async <T>(
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>,
  ) => {
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new Error("Host observation timed out"));
    }, 5000);
    try {
      return await action(signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    memoryAvailable: (signal) =>
      observe(signal, async (signal) => {
        const bytes = await boundedRead(join(root, "meminfo"), 64 * 1024, signal);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const entries = text.split("\n").filter((line) => line.startsWith("MemAvailable:"));
        const match = /^MemAvailable:[ \t]+(\d+) kB$/u.exec(entries[0] ?? "");
        const value = Number(match?.[1]) * 1024;
        if (entries.length !== 1 || !Number.isSafeInteger(value) || value < 0)
          throw new Error("Memory unavailable");
        return value;
      }),
    processIdentity: (executable, signal) =>
      observe(signal, async (signal) => {
        signal.throwIfAborted();
        if (uid === undefined) throw new Error("Legacy daemon identity unavailable");
        const entries = await opendir(root);
        let count = 0;
        let found: { pid: number; started: string } | undefined;
        const expected = Buffer.from(`${executable}\0--daemon\0`);
        for await (const entry of entries) {
          signal.throwIfAborted();
          if (++count > 131072) throw new Error("Legacy daemon identity unavailable");
          if (!/^[1-9]\d*$/u.test(entry.name) || !entry.isDirectory()) continue;
          const pid = Number(entry.name);
          if (!Number.isSafeInteger(pid) || pid <= 1) continue;
          const directory = join(root, entry.name);
          try {
            const owner = await lstat(directory);
            if (!owner.isDirectory() || owner.uid !== uid) continue;
            const first = await boundedRead(join(directory, "stat"), 64 * 1024, signal);
            const args = await boundedRead(join(directory, "cmdline"), 256 * 1024, signal);
            if (!args.equals(expected)) continue;
            const started = startTime(first, entry.name);
            const again = startTime(
              await boundedRead(join(directory, "stat"), 64 * 1024, signal),
              entry.name,
            );
            const currentOwner = await lstat(directory);
            if (again !== started || !currentOwner.isDirectory() || currentOwner.uid !== uid)
              continue;
            if (found) throw new Error("Legacy daemon identity unavailable");
            found = { pid, started };
          } catch (error) {
            signal.throwIfAborted();
            if (
              error instanceof Error &&
              "code" in error &&
              (error.code === "ENOENT" || error.code === "ESRCH")
            )
              continue;
            throw error;
          }
        }
        signal.throwIfAborted();
        return found;
      }),
  };
}
