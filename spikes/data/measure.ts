import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import BetterSQLite from "better-sqlite3";
import { drizzle as nodeDrizzle } from "drizzle-orm/node-sqlite";
import { drizzle as betterDrizzle } from "drizzle-orm/better-sqlite3";
import { eq, gt, sql } from "drizzle-orm";
import { performance } from "node:perf_hooks";
import { migration } from "./migration-path";
import { hosts, repositories, worktrees, sessions, changes } from "./schema";

export type Engine = "node:sqlite" | "better-sqlite3";

export function measure(engine: Engine, path: string, nativeBinding?: string) {
  function open() {
    const client = engine === "node:sqlite"
      ? new DatabaseSync(path)
      : new BetterSQLite(path, nativeBinding ? { nativeBinding } : undefined);
    // Applied on EVERY connection, before schema checks or transactions.
    client.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    const db = client instanceof DatabaseSync ? nodeDrizzle({ client }) : betterDrizzle({ client });
    assert.equal(db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)?.foreign_keys, 1);
    return { client, db };
  }
  let { client, db } = open();
  try {
    db.transaction((tx) => {
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) tx.run(sql.raw(statement));
      }
      tx.run(sql`PRAGMA user_version=1`);
    });
    const tables = db.all<{ name: string; strict: number }>(sql`PRAGMA table_list`);
    for (const name of ["hosts", "repositories", "worktrees", "sessions", "_changes"]) {
      assert.equal(tables.find((t) => t.name === name)?.strict, 1, name);
    }
    db.transaction((tx) => {
      tx.insert(hosts).values({ id: "host", name: "Fixture" }).run();
      tx.insert(repositories).values({ id: "repo", hostId: "host" }).run();
      tx.insert(worktrees).values({ id: "tree", repositoryId: "repo" }).run();
      const insert = tx.insert(sessions).values({
        id: sql.placeholder("id"), worktreeId: "tree", state: "running",
      }).prepare();
      for (let id = 1; id <= 10_000; id++) insert.run({ id });
    });
    // Each FK is checked, including host removal and insertion of an orphan.
    for (const statement of [
      "DELETE FROM hosts WHERE id='host'",
      "DELETE FROM repositories WHERE id='repo'",
      "DELETE FROM worktrees WHERE id='tree'",
      "INSERT INTO repositories VALUES ('orphan', 'missing')",
      "INSERT INTO sessions VALUES (10001, 'tree', 'invalid')",
      "INSERT INTO sessions VALUES ('not-an-integer', 'tree', 'running')",
    ]) assert.throws(() => db.run(sql.raw(statement)));
    assert.equal(db.all(sql`PRAGMA foreign_key_check`).length, 0);

    const revision = () => db.select({ value: sql<number>`coalesce(max(revision), 0)` }).from(changes).get()?.value ?? 0;
    const beforeRollback = revision();
    assert.throws(() => db.transaction((tx) => {
      tx.update(hosts).set({ name: "rolled back" }).where(eq(hosts.id, "host")).run();
      throw new Error("rollback fixture");
    }));
    assert.equal(revision(), beforeRollback);
    // Raw SQL and INSERT/UPDATE/DELETE all invalidate; _changes never triggers itself.
    for (const table of ["hosts", "repositories", "worktrees", "sessions"]) {
      for (const event of ["insert", "update", "delete"]) {
        assert.equal(db.all(sql`SELECT name FROM sqlite_schema WHERE type='trigger' AND name=${`${table}_${event}`}`).length, 1);
      }
    }
    const beforeRaw = revision();
    db.transaction((tx) => {
      tx.run(sql`INSERT INTO hosts VALUES ('raw', 'raw')`);
      tx.run(sql`UPDATE hosts SET name='changed' WHERE id='raw'`);
      tx.run(sql`DELETE FROM hosts WHERE id='raw'`);
    });
    assert.equal(revision(), beforeRaw + 3);
    assert.equal(db.select().from(changes).where(gt(changes.revision, beforeRaw)).all().length, 3);

    client.close();
    // Reopen an existing 10k-row DB. OS page cache is NOT flushed.
    const coldStart = performance.now();
    ({ client, db } = open());
    assert.equal(db.get<{ user_version: number }>(sql`PRAGMA user_version`)?.user_version, 1);
    assert.equal(db.all(sql`PRAGMA foreign_key_check`).length, 0);
    const coldOpenSchemaMs = performance.now() - coldStart;
    const write: number[] = [], changeRead: number[] = [], list: number[] = [];
    for (let i = 0; i < 30; i++) {
      const cursor = revision();
      const start = performance.now();
      db.transaction((tx) => tx.update(sessions).set({ state: i % 2 ? "running" : "exited" }).where(eq(sessions.id, 1)).run());
      const committed = performance.now();
      const delta = db.select().from(changes).where(gt(changes.revision, cursor)).all();
      const read = performance.now();
      assert.equal(delta.length, 1);
      assert.equal(delta[0]?.tableName, "sessions");
      write.push(committed - start);
      changeRead.push(read - start);
      const queryStart = performance.now();
      assert.equal(db.select().from(sessions).where(eq(sessions.worktreeId, "tree")).orderBy(sessions.id).all().length, 10_000);
      list.push(performance.now() - queryStart);
    }
    const distribution = (values: number[]) => {
      values.sort((a, b) => a - b);
      return { median: values[Math.floor(values.length / 2)], p95: values[Math.ceil(values.length * .95) - 1] };
    };
    return {
      engine, platform: process.platform, arch: process.arch, versions: process.versions,
      sqlite: db.get(sql`SELECT sqlite_version() AS version`),
      coldOpenSchemaMs, writeMs: distribution(write), writeToChangesMs: distribution(changeRead),
      list10kMs: distribution(list), samples: 30,
      assertions: "STRICT, CHECK, all FK deletes, orphan insert, FK readback, trigger coverage, raw SQL, rollback, reopen",
    };
  } finally { client.close(); }
}
