import { constants } from "node:fs";
import { lstat, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivate, createPrivateFile, verifyPrivate } from "./private-files";
import { ControlError, object } from "./validation";
import type { StoredOperation } from "./types";

/** Durable deduplication state and independently rotated, clearable action history. */
export class ControlStore {
  constructor(private readonly directory: string) {}

  async persist(record: StoredOperation): Promise<void> {
    // Snapshots have a bounded count enforced by Operations; never rotate live deduplication.
    await atomicPrivate(this.directory, `operation-${record.operation.operationId}.json`, record);
    await this.append({ actor: record.actor, ...record.operation });
  }

  async recover(): Promise<void> {
    await this.prune();
    // No credentials survive restart. Preserve old records for human reconciliation, never replay.
    for (const name of await readdir(this.directory)) {
      if (/^operation-[a-f0-9-]{36}\.json$/u.test(name)) {
        const source = join(this.directory, name);
        await verifyPrivate(source, false);
        if ((await lstat(source)).size > 16384) throw new ControlError("unavailable");
        const value: unknown = JSON.parse(await readFile(source, "utf8"));
        const status = object(object(value)["operation"])["status"];
        if (
          typeof status !== "string" ||
          ![
            "pending_confirmation",
            "running",
            "succeeded",
            "failed",
            "declined",
            "cancelled",
            "indeterminate",
          ].includes(status)
        )
          throw new ControlError("unavailable");
        await this.append({
          operationId: name.slice(10, -5),
          status: ["pending_confirmation", "running"].includes(status) ? "indeterminate" : status,
          reason: "recovery",
        });
        await rm(source);
      }
    }
  }

  async clearAudit(): Promise<void> {
    for (let index = 0; index < 5; index++)
      await rm(join(this.directory, `actions-${String(index)}.jsonl`), { force: true });
  }

  private async prune(): Promise<void> {
    for (let index = 0; index < 5; index++) {
      const path = join(this.directory, `actions-${String(index)}.jsonl`);
      try {
        await verifyPrivate(path, false);
        const info = await lstat(path);
        // Age from creation, not the most recent append, so active logs also expire.
        if (Date.now() - Math.min(info.birthtimeMs, info.mtimeMs) > 30 * 24 * 60 * 60 * 1000)
          await rm(path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }

  private async append(value: Record<string, unknown>): Promise<void> {
    await verifyPrivate(this.directory, true);
    const current = join(this.directory, "actions-0.jsonl");
    await this.prune();
    const json = `${JSON.stringify({ timestamp: new Date().toISOString(), ...value })}\n`;
    let size = 0;
    try {
      size = (await lstat(current)).size;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (size + Buffer.byteLength(json) > 10 * 1024 * 1024) {
      await rm(join(this.directory, "actions-4.jsonl"), { force: true });
      for (let index = 3; index >= 0; index--) {
        try {
          await rename(
            join(this.directory, `actions-${String(index)}.jsonl`),
            join(this.directory, `actions-${String(index + 1)}.jsonl`),
          );
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
    }
    let file;
    try {
      file = await createPrivateFile(current);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      await verifyPrivate(current, false);
      file = await open(
        current,
        constants.O_WRONLY |
          constants.O_APPEND |
          (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
    }
    try {
      if (!(await file.stat()).isFile()) throw new ControlError("unavailable");
      await file.writeFile(json);
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
