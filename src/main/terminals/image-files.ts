import { createHash, randomBytes } from "node:crypto";
import { lstat, opendir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import {
  createPrivateFile,
  privateDirectory,
  verifyPrivate,
} from "../../node-common/private-files";
import { IMAGE_FILES, IMAGE_SESSION_BYTES, imagePng, imageCleanup } from "../../shared/image-paste";

type Session = { directory: string; count: number; bytes: number; closing?: Promise<void> };
/** A profile has one owner. Other running profiles have independent temp roots. */
export class ImageFiles {
  private root: Promise<string> | undefined;
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly profile: () => string) {}
  start(): Promise<string> {
    this.root ??= (async () => {
      const key = createHash("sha256").update(this.profile()).digest("hex").slice(0, 24);
      const root = await privateDirectory(
        tmpdir(),
        `foom-images-${String(process.getuid?.() ?? "user")}-${key}`,
      );
      // Only generated direct children. Yield between bounded batches after crashes.
      let batch = 0;
      for await (const item of await opendir(root)) {
        const entry = item.name;
        if (!/^[a-f0-9]{32}$/u.test(entry)) continue;
        await imageCleanup(() => this.removeDirectory(join(root, entry)));
        if (++batch % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return root;
    })();
    return this.root;
  }
  private async removeDirectory(directory: string): Promise<void> {
    await verifyPrivate(directory, true);
    for (const entry of await readdir(directory)) {
      if (!/^image-[a-f0-9]{32}\.(?:png|partial)$/u.test(entry))
        throw new Error("Unsafe image directory");
      const path = join(directory, entry);
      await verifyPrivate(path, false);
      await rm(path);
    }
    await rmdir(directory);
  }
  async put(id: string, png: Uint8Array, signal: AbortSignal): Promise<string> {
    if (!imagePng(png)) throw new Error("Invalid normalized image");
    const root = await this.start();
    signal.throwIfAborted();
    await verifyPrivate(root, true);
    let session = this.sessions.get(id);
    if (!session) {
      const directory = await privateDirectory(root, randomBytes(16).toString("hex"));
      session = { directory, count: 0, bytes: 0 };
      this.sessions.set(id, session);
    }
    if (session.count >= IMAGE_FILES || session.bytes + png.length > IMAGE_SESSION_BYTES)
      throw new Error("Image quota refused");
    session.count++;
    session.bytes += png.length;
    const directory = session.directory;
    const name = `image-${randomBytes(16).toString("hex")}`;
    const partial = join(directory, `${name}.partial`);
    const path = join(directory, `${name}.png`);
    let published = false;
    try {
      await verifyPrivate(directory, true);
      const identity = await lstat(directory);
      const file = await createPrivateFile(partial);
      try {
        await file.writeFile(png);
      } finally {
        await file.close();
      }
      signal.throwIfAborted();
      await verifyPrivate(root, true);
      await verifyPrivate(directory, true);
      const current = await lstat(directory);
      if (identity.dev !== current.dev || identity.ino !== current.ino)
        throw new Error("Image directory changed");
      await verifyPrivate(partial, false);
      await rename(partial, path);
      published = true;
      signal.throwIfAborted();
      await verifyPrivate(path, false);
      return path;
    } catch (error) {
      await rm(published ? path : partial, { force: true });
      session.count--;
      session.bytes -= png.length;
      throw error;
    }
  }
  async discard(id: string, path: string, size: number): Promise<void> {
    const session = this.sessions.get(id);
    if (
      !session ||
      dirname(path) !== session.directory ||
      !/^image-[a-f0-9]{32}\.png$/u.test(basename(path))
    )
      return;
    await verifyPrivate(path, false);
    await rm(path);
    session.count--;
    session.bytes -= size;
  }
  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.closing ??= imageCleanup(() => this.removeDirectory(session.directory))
      .then(() => {
        this.sessions.delete(id);
      })
      .catch((error: unknown) => {
        delete session.closing;
        throw error;
      });
    await session.closing;
  }
  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
