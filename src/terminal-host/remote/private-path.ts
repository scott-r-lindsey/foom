import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
/** Never follow a pre-existing link or accept another user's/accessible directory. */
export function privateDirectory(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0"))
    throw new Error("Invalid host path");
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new Error("Unsafe host directory");
}
export function hostSocket(home: string): string {
  if (!isAbsolute(home) || resolve(home) !== home || realpathSync(home) !== home)
    throw new Error("Invalid home directory");
  const info = lstatSync(home);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0
  )
    throw new Error("Unsafe home directory");
  const root = join(home, ".foom-host");
  privateDirectory(root);
  const socket = join(root, "host.sock");
  if (Buffer.byteLength(socket) > 100) throw new Error("Host socket path too long");
  return socket;
}
export function checkSocket(path: string): void {
  const info = lstatSync(path);
  if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600)
    throw new Error("Unsafe host socket");
}
