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
    const current = lstatSync(token.path);
    return (
      count === 32 &&
      current.dev === opened.dev &&
      current.ino === opened.ino &&
      current.size === 32 &&
      value.subarray(0, count).toString("ascii") === token.nonce
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
