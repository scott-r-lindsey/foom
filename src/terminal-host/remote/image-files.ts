import { randomBytes } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { open, opendir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { privateDirectory } from "./private-path";
import { IMAGE_FILES, IMAGE_SESSION_BYTES, imagePng, imageCleanup } from "../../shared/image-paste";

type Images = { directory: string; count: number; bytes: number; closing?: Promise<void> };
/** Daemon ownership, independent of the SSH connection and hub lifetime. */
export class RemoteImages {
  private readonly sessions = new Map<string, Images>();
  private readonly root: string;
  readonly ready: Promise<void>;
  constructor(home: string) {
    this.root = join(home, ".foom-host", "images");
    privateDirectory(this.root);
    this.ready = this.purge();
  }
  private file(path: string): void {
    const info = lstatSync(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.nlink !== 1
    )
      throw new Error("Unsafe image file");
  }
  private async remove(directory: string): Promise<void> {
    privateDirectory(directory);
    for (const name of await readdir(directory)) {
      if (!/^image-[a-f0-9]{32}\.(?:partial|png)$/u.test(name))
        throw new Error("Unsafe image directory");
      const path = join(directory, name);
      this.file(path);
      await rm(path);
    }
    await rmdir(directory);
  }
  private async purge(): Promise<void> {
    let count = 0;
    for await (const item of await opendir(this.root)) {
      const name = item.name;
      if (/^[a-f0-9]{32}$/u.test(name))
        await imageCleanup(() => this.remove(join(this.root, name)));
      if (++count % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  async put(this: RemoteImages, id: string, png: Uint8Array, live: () => boolean): Promise<string> {
    await this.ready;
    if (!live() || !imagePng(png)) throw new Error("Image refused");
    privateDirectory(this.root);
    let session = this.sessions.get(id);
    if (!session) {
      const directory = join(this.root, randomBytes(16).toString("hex"));
      privateDirectory(directory);
      session = { directory, count: 0, bytes: 0 };
      this.sessions.set(id, session);
    }
    if (session.count >= IMAGE_FILES || session.bytes + png.length > IMAGE_SESSION_BYTES)
      throw new Error("Image quota refused");
    session.count++;
    session.bytes += png.length;
    const directory = session.directory;
    privateDirectory(directory);
    const identity = lstatSync(directory);
    const name = `image-${randomBytes(16).toString("hex")}`;
    const partial = join(directory, `${name}.partial`);
    const path = join(directory, `${name}.png`);
    let published = false;
    try {
      const file = await open(
        partial,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(png);
      } finally {
        await file.close();
      }
      privateDirectory(this.root);
      privateDirectory(directory);
      const current = lstatSync(directory);
      if (!live() || identity.dev !== current.dev || identity.ino !== current.ino)
        throw new Error("Image cancelled");
      this.file(partial);
      await rename(partial, path);
      published = true;
      if (!live()) throw new Error("Image cancelled");
      this.file(path);
      return path;
    } catch (error) {
      await rm(published ? path : partial, { force: true });
      session.count--;
      session.bytes -= png.length;
      throw error;
    }
  }
  async close(id: string): Promise<void> {
    await this.ready;
    const session = this.sessions.get(id);
    if (!session) return;
    session.closing ??= imageCleanup(() => this.remove(session.directory))
      .then(() => {
        this.sessions.delete(id);
      })
      .catch((error: unknown) => {
        delete session.closing;
        throw error;
      });
    await session.closing;
  }
}
