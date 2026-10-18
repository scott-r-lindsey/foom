import type { Handoff } from "../../shared/handoff";
import type { PreviewAudit } from "./previews";
import { randomUUID } from "node:crypto";
import type { ActionLogEntry, ActionLogPage } from "../../shared/action-log";
import { prepareTail } from "../evaluator/terminal-tail";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivate, createPrivateFile, verifyPrivate } from "../../node-common/private-files";
import { ControlError, object, exact } from "../../node-common/control-validation";
import type { Principal, StoredOperation } from "./types";

/** Durable deduplication state and independently rotated, clearable action history. */
export class ControlStore {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly directory: string,
    private readonly changed: () => void = () => {},
    private readonly rotationBytes = 10 * 1024 * 1024,
  ) {}

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writes.then(task, task);
    this.writes = next.catch(() => undefined);
    return next;
  }

  /** Human commands persist intent before changing authority, just like automation. */
  human(
    action: string,
    actorId: string,
    repository: string,
    worktree: string,
    targetId: string | null,
    status: string,
    operationId: string = randomUUID(),
  ): Promise<void> {
    return this.serialize(() =>
      this.append({
        operationId,
        action,
        status,
        reason:
          status === "running" || status === "pending_confirmation"
            ? "intent"
            : status === "declined" || status === "refused"
              ? "refused"
              : status === "indeterminate"
                ? "uncertain"
                : "completed",
        actor: { terminalId: "human", parentId: actorId, repository, worktree },
        targetId,
      }),
    );
  }

  refused(
    actor: Principal,
    action: string,
    status = "refused",
    targetId: string | null = null,
  ): Promise<void> {
    return this.serialize(() =>
      this.append({
        actor,
        action,
        operationId: randomUUID(),
        status,
        targetId,
        reason: status === "refused" ? "refused" : "completed",
      }),
    );
  }

  handoff(actor: Principal, report: Handoff): Promise<void> {
    return this.serialize(() =>
      this.append({
        actor,
        operationId: randomUUID(),
        action: "handoff",
        targetId: actor.terminalId,
        status: "succeeded",
        reason: `Handoff #${String(report.seq)} (${report.status})`,
      }),
    );
  }

  preview(event: PreviewAudit): Promise<void> {
    return this.serialize(() =>
      this.append({
        operationId: randomUUID(),
        actorId: event.session,
        action: event.action,
        targetId: event.preview,
        path: event.path,
        session: event.session,
        status: event.outcome,
        reason: event.outcome === "opening" || event.outcome === "closing" ? "intent" : "completed",
      }),
    );
  }

  read(query: unknown): Promise<ActionLogPage> {
    return this.serialize(async () => {
      const value = object(query);
      exact(value, ["search", "action", "status", "offset"]);
      const { search, action, status, offset } = value;
      if (
        typeof search !== "string" ||
        search.length > 256 ||
        typeof action !== "string" ||
        action.length > 64 ||
        typeof status !== "string" ||
        status.length > 64 ||
        typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        throw new ControlError("invalid_request");
      await verifyPrivate(this.directory, true);
      await this.prune();
      const entries: ActionLogEntry[] = [];
      for (let index = 0; index < 5; index++) {
        const path = join(this.directory, `actions-${String(index)}.jsonl`);
        try {
          await verifyPrivate(path, false);
          if ((await lstat(path)).size > this.rotationBytes) throw new ControlError("unavailable");
          for (const line of (await readFile(path, "utf8")).split("\n")) {
            if (!line) continue;
            const data: unknown = JSON.parse(line);
            const entry = auditEntry(data);
            if (Date.now() - Date.parse(entry.timestamp) > 30 * 24 * 60 * 60 * 1000) continue;
            if ((action && entry.action !== action) || (status && entry.status !== status))
              continue;
            if (
              search &&
              !Object.values(entry)
                .join(" ")
                .toLocaleLowerCase()
                .includes(search.toLocaleLowerCase())
            )
              continue;
            entries.push(entry);
          }
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
      entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return { entries: entries.slice(offset, offset + 100), total: entries.length };
    });
  }

  async persist(record: StoredOperation): Promise<void> {
    return this.serialize(async () => {
      // Keep the final outcome recoverable until its audit entry is durable.
      await atomicPrivate(this.directory, `operation-${record.operation.operationId}.json`, record);
      await this.append({ actor: record.actor, ...record.operation });
      if (!["pending_confirmation", "running"].includes(record.operation.status))
        await rm(join(this.directory, `operation-${record.operation.operationId}.json`));
    });
  }

  async recover(): Promise<void> {
    return this.serialize(async () => {
      await this.prune();
      const sources: string[] = [];
      const entries: ActionLogEntry[] = [];
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
          const entry = auditEntry({
            timestamp: new Date().toISOString(),
            actor: object(value)["actor"],
            ...object(object(value)["operation"]),
            operationId: name.slice(10, -5),
            status: ["pending_confirmation", "running"].includes(status) ? "indeterminate" : status,
            reason: "recovery",
          });
          if (["pending_confirmation", "running"].includes(status)) entries.push(entry);
          sources.push(source);
        }
      }
      await this.appendEntries(entries);
      for (const source of sources) await rm(source);
    });
  }

  async clearAudit(): Promise<void> {
    await this.serialize(async () => {
      await verifyPrivate(this.directory, true);
      for (let index = 0; index < 5; index++)
        await rm(join(this.directory, `actions-${String(index)}.jsonl`), { force: true });
      this.changed();
    });
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
    await this.appendEntries([auditEntry({ timestamp: new Date().toISOString(), ...value })]);
  }

  /** One write and sync per recovery batch; split only at the audit rotation boundary. */
  private async appendEntries(entries: readonly ActionLogEntry[]): Promise<void> {
    let batch = "";
    let bytes = 0;
    for (const entry of entries) {
      const line = `${JSON.stringify(entry)}\n`;
      const size = Buffer.byteLength(line);
      if (bytes + size > this.rotationBytes) {
        await this.appendJson(batch);
        batch = "";
        bytes = 0;
      }
      batch += line;
      bytes += size;
    }
    if (batch) await this.appendJson(batch);
  }

  private async appendJson(json: string): Promise<void> {
    await verifyPrivate(this.directory, true);
    const current = join(this.directory, "actions-0.jsonl");
    await this.prune();
    let size = 0;
    try {
      size = (await lstat(current)).size;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (size + Buffer.byteLength(json) > this.rotationBytes) {
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
      this.changed();
    } finally {
      await file.close();
    }
  }
}

/** Whitelist every persisted/rendered field; old recovery entries have only outcome metadata. */
function auditEntry(value: unknown): ActionLogEntry {
  const data = object(value);
  const actor = data["actor"] === undefined ? data : object(data["actor"]);
  const text = (value: unknown, fallback = ""): string => {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "string" || value.length > 8192) throw new ControlError("unavailable");
    return prepareTail([value]).slice(0, 4096);
  };
  // Main-generated IDs are opaque metadata, not terminal text. In particular, a
  // hexadecimal worktree ID must not be mistaken for a leading PEM body line.
  const identity = (value: unknown, fallback = ""): string => {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/u.test(value))
      throw new ControlError("unavailable");
    return value;
  };
  const timestamp = text(data["timestamp"]);
  if (!Number.isFinite(Date.parse(timestamp))) throw new ControlError("unavailable");
  return {
    operationId: identity(data["operationId"]),
    timestamp,
    actorId: identity(actor["terminalId"] ?? data["actorId"], "unknown"),
    parentId: actor["parentId"] == null ? null : identity(actor["parentId"]),
    repository: text(actor["repository"]),
    worktree: text(actor["worktree"]),
    action: text(data["action"], "recovery"),
    targetId: data["targetId"] == null ? null : identity(data["targetId"]),
    resultId: data["resultId"] == null ? null : identity(data["resultId"]),
    status: text(data["status"]),
    reason: text(data["reason"]),
    ...(data["path"] === undefined
      ? {}
      : { path: text(data["path"]), session: identity(data["session"]) }),
    ...(data["proposal"] === undefined ? {} : { proposal: text(data["proposal"]) }),
  };
}
