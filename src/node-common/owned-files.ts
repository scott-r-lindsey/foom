import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { createPrivateFile, verifyPrivate } from "./private-files";
export async function writeOwnedFile(target: string, content: string): Promise<void> {
  const handle = await createPrivateFile(target);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await verifyPrivate(target, false);
}
/** Bounded no-link reads, with identity checks around the opened handle. */
export async function readOwnedFile(
  target: string,
  limit: number,
  verify = verifyPrivate,
): Promise<string> {
  await verify(target, false);
  const expected = await lstat(target);
  const handle = await open(
    target,
    constants.O_RDONLY |
      constants.O_NONBLOCK |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size > limit
    )
      throw Error("Invalid owned file");
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const current = await lstat(target);
    await verify(target, false);
    if (bytesRead > limit || current.dev !== opened.dev || current.ino !== opened.ino)
      throw Error("Invalid owned file");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
