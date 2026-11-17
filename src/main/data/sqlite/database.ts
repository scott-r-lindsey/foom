import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import {
  createPrivateFile,
  privateDirectory,
  verifyPrivate,
} from "../../../node-common/private-files";
import { viewChanges } from "../view-changes";
import type { DataView } from "../../../shared/data-views";
import type { ViewChanges } from "../view-changes";

const migration = () =>
  readFileSync(join(__dirname, "migrations/20261117073834_medical_morg/migration.sql"), "utf8");
const internal = new Set(["_changes", "_imports", "_schema"]);
const views: Readonly<Record<string, readonly DataView[]>> = {
  hosts: ["hosts", "settings", "agents"],
  repositories: ["repositories", "worktrees", "readiness"],
  worktrees: ["worktrees"],
  sessions: ["sessions"],
  owned_worktrees: ["sessions", "worktrees"],
  pending_removals: ["worktrees"],
  worktree_parents: ["worktrees"],
  quarantine: [],
};
const allViews: DataView[] = [
  "settings",
  "hosts",
  "agents",
  "repositories",
  "worktrees",
  "sessions",
  "environment",
  "config",
  "fonts",
  "sounds",
  "readiness",
];

export function assertForeignKeys(connection: DatabaseSync): void {
  if (connection.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"] !== 1)
    throw new Error(
      "Profile database requires foreign_keys=ON; restore integrity before continuing",
    );
}

/** Main infrastructure only. Domain commands/imports share this serialized boundary.
 * Deliberately not opened by application startup during phase C.
 */
export class ProfileDatabase {
  private readonly orm;
  private pending: Promise<unknown> = Promise.resolve();
  private cursor = 0;
  private invalidateAll = false;
  private closed = false;
  private constructor(
    private readonly connection: DatabaseSync,
    private readonly publications: Pick<ViewChanges, "publish">,
  ) {
    this.orm = drizzle({ client: connection });
  }
  static async open(
    profile: string,
    publications: Pick<ViewChanges, "publish"> = viewChanges,
  ): Promise<ProfileDatabase> {
    const directory = await privateDirectory(profile, "data");
    const file = join(directory, "profile.sqlite");
    try {
      const handle = await createPrivateFile(file);
      await handle.close();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await verifyPrivate(file, false);
    const connection = new DatabaseSync(file);
    try {
      connection.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
      );
      // Must precede even the schema-version query and migration.
      assertForeignKeys(connection);
      const database = new ProfileDatabase(connection, publications);
      database.migrate();
      database.verify();
      return database;
    } catch (error) {
      connection.close();
      throw error;
    }
  }
  private migrate(): void {
    const version = this.connection.prepare("PRAGMA user_version").get()?.["user_version"];
    if (version !== 0 && version !== 1)
      throw new Error("Unsupported profile database version; use a compatible Foom build");
    const sql = migration();
    const digest = createHash("sha256").update(sql).digest("hex");
    if (version === 1) {
      if (
        this.connection.prepare("SELECT digest FROM _schema WHERE version=1").get()?.["digest"] !==
        digest
      )
        throw new Error("Profile database migration checksum mismatch; restore a verified backup");
      return;
    }
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      this.connection.exec(sql);
      this.connection.exec(
        "CREATE TABLE _schema (version INTEGER PRIMARY KEY, digest TEXT NOT NULL) STRICT",
      );
      this.connection.prepare("INSERT INTO _schema VALUES(1, ?)").run(digest);
      this.connection.exec("PRAGMA user_version=1; COMMIT");
      this.invalidateAll = true;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }
  private verify(): void {
    if (
      this.connection.prepare("PRAGMA quick_check").get()?.["quick_check"] !== "ok" ||
      this.connection.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("Profile database integrity check failed; restore a verified backup");
    const tables = this.connection
      .prepare("PRAGMA table_list")
      .all()
      .filter(
        (row) =>
          row["schema"] === "main" &&
          typeof row["name"] === "string" &&
          !row["name"].startsWith("sqlite_"),
      );
    const expected = new Set([...Object.keys(views), ...internal]);
    for (const row of tables) {
      const name = String(row["name"]);
      if (row["strict"] !== 1 || !expected.delete(name))
        throw new Error("Unexpected or non-STRICT profile table");
      if (internal.has(name)) continue;
      const triggers = this.connection
        .prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name=?")
        .all(name);
      if (
        !["insert", "update", "delete"].every((op) =>
          triggers.some((trigger) => trigger["name"] === `${name}_${op}`),
        )
      )
        throw new Error("Profile database change triggers are incomplete");
    }
    if (expected.size) throw new Error("Profile database tables are incomplete");
  }
  /** Synchronous transaction bodies cannot yield partially committed state. */
  write<T>(writer: (db: typeof this.orm) => T): Promise<{ value: T; publicationPending: boolean }> {
    return this.serialize(() => {
      assertForeignKeys(this.connection);
      this.connection.exec("BEGIN IMMEDIATE");
      let value: T;
      try {
        value = writer(this.orm);
        if (value instanceof Promise) throw new Error("Database transactions must be synchronous");
        this.connection.exec("COMMIT");
      } catch (error) {
        this.connection.exec("ROLLBACK");
        throw error;
      }
      try {
        this.drain();
        return { value, publicationPending: false };
      } catch {
        // The write already committed. Do not invite a duplicate external effect.
        return { value, publicationPending: true };
      }
    });
  }
  retryPublication(): Promise<void> {
    return this.serialize(() => {
      this.drain();
    });
  }
  private drain(): void {
    const rows = this.connection
      .prepare("SELECT revision, table_name FROM _changes WHERE revision > ? ORDER BY revision")
      .all(this.cursor);
    const affected = new Set<DataView>(this.invalidateAll ? allViews : []);
    let next = this.cursor;
    for (const row of rows) {
      for (const view of views[String(row["table_name"])] ?? allViews) affected.add(view);
      next = Number(row["revision"]);
    }
    if (affected.size) this.publications.publish(...affected);
    // Advance only after all publication succeeds. Keep log rows for retry/recovery.
    this.cursor = next;
    this.invalidateAll = false;
  }
  private serialize<T>(action: () => T): Promise<T> {
    const next = this.pending
      .catch(() => undefined)
      .then(() => {
        if (this.closed) throw new Error("Profile database is closed");
        return action();
      });
    this.pending = next;
    return next;
  }
  async close(): Promise<void> {
    await this.pending.catch(() => undefined);
    this.closed = true;
    this.connection.close();
  }
}
