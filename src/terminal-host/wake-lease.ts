import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import type { WakeToken } from "../shared/agent-wake";

/** Bounded synchronous token read immediately before PTY write; missing/changed files refuse. */
export function wakeLeaseValid(token: WakeToken): boolean {
  let fd: number | undefined;
  try {
    const expected = lstatSync(token.path);
    if (
      !expected.isFile() ||
      expected.isSymbolicLink() ||
      expected.size !== 32 ||
      expected.nlink !== 1
    )
      return false;
    fd = openSync(
      token.path,
      constants.O_RDONLY |
        constants.O_NONBLOCK |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size !== 32
    )
      return false;
    const value = Buffer.alloc(33);
    const count = readSync(fd, value, 0, value.length, 0);
    // Finish cleanup before the final observation, keeping its path to PTY write synchronous.
    closeSync(fd);
    fd = undefined;
    if (count !== 32 || value.subarray(0, count).toString("ascii") !== token.nonce) return false;
    const current = lstatSync(token.path);
    return current.dev === opened.dev && current.ino === opened.ino && current.size === 32;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
