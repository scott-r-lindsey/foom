import { randomUUID } from "node:crypto";
import { openSync, closeSync, writeSync, ftruncateSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateDirectory } from "../../node-common/private-files";
import type { WakeToken } from "../../shared/agent-wake";

type Entry = { eligible: () => boolean; revoked: boolean; fd?: number };
/** Utility-process messages cannot share SABs. A private, one-use inode is the revocable token. */
export class WakeGuards {
  private root: Promise<string> | undefined;
  private readonly entries = new Set<Entry>();
  private disposed = false;
  recheck(force = false): void {
    for (const entry of this.entries) {
      if (entry.revoked) continue;
      let eligible = false;
      try {
        eligible = !this.disposed && !force && entry.eligible();
      } catch {
        /* revoked authority */
      }
      if (!eligible) {
        entry.revoked = true;
        // Synchronous visibility: no IPC invalidation can trail the host's parser callback.
        if (entry.fd !== undefined) ftruncateSync(entry.fd, 0);
      }
    }
  }
  async create(
    eligible: () => boolean,
  ): Promise<{ token: WakeToken; release(): void } | undefined> {
    if (this.disposed) return undefined;
    const entry: Entry = { eligible, revoked: this.disposed };
    this.entries.add(entry);
    let path: string | undefined;
    const release = () => {
      if (entry.fd !== undefined) {
        ftruncateSync(entry.fd, 0);
        closeSync(entry.fd);
        delete entry.fd;
      }
      this.entries.delete(entry);
      if (path) rmSync(path, { force: true });
    };
    try {
      this.root ??= privateDirectory(tmpdir(), `foom-wake-${randomUUID()}`);
      const root = await this.root;
      this.recheck();
      if (entry.revoked) {
        release();
        return undefined;
      }
      const nonce = randomUUID().replaceAll("-", "");
      path = join(root, nonce);
      entry.fd = openSync(path, "wx", 0o600);
      if (writeSync(entry.fd, nonce) !== nonce.length)
        throw new Error("Unable to create wake guard");
      return { token: { path, nonce }, release };
    } catch (error) {
      release();
      throw error;
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.recheck();
    if (this.root)
      await this.root.then((root) => rm(root, { recursive: true, force: true })).catch(() => {});
  }
}
