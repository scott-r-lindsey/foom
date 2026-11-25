import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ThemeValidationError } from "../../shared/theme-validation";

const unsafe = () => new ThemeValidationError("$", "unsafe-file");

/** Read a bounded direct child and recheck both the opened file and its folder. */
export async function readThemeFile(
  directory: string,
  name: string,
  max: number,
  allowLinks: boolean,
): Promise<Buffer> {
  const parentPath = dirname(directory);
  const parent = await lstat(parentPath);
  if (!parent.isDirectory()) throw unsafe();
  const folder = await lstat(directory);
  if (!folder.isDirectory()) throw unsafe();
  const root = await realpath(directory);
  const named = join(root, name);
  const target = await realpath(named);
  if (dirname(target) !== root) throw unsafe();
  const before = await lstat(allowLinks ? target : named);
  if (!before.isFile() || (!allowLinks && before.nlink !== 1)) throw unsafe();
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev) throw unsafe();
    if (info.size > max) throw new ThemeValidationError("$", "too-large");
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const current = await lstat(allowLinks ? target : named);
    if (current.size > max) throw new ThemeValidationError("$", "too-large");
    const currentFolder = await lstat(directory);
    const currentParent = await lstat(parentPath);
    if (
      !currentParent.isDirectory() ||
      currentParent.ino !== parent.ino ||
      currentParent.dev !== parent.dev ||
      !currentFolder.isDirectory() ||
      currentFolder.ino !== folder.ino ||
      currentFolder.dev !== folder.dev ||
      (await realpath(directory)) !== root ||
      (await realpath(named)) !== target ||
      !current.isFile() ||
      (!allowLinks && current.nlink !== 1) ||
      current.ino !== info.ino ||
      current.dev !== info.dev ||
      size !== info.size ||
      current.size !== size ||
      current.mtimeMs !== info.mtimeMs ||
      current.ctimeMs !== info.ctimeMs
    )
      throw unsafe();
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}
