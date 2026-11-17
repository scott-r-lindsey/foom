import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

// Reviewed generated SQL adds STRICT (not supported by Drizzle rc.5).
export const hosts = sqliteTable(
  "hosts",
  {
    alias: text().primaryKey().notNull(),
    data: text().notNull(),
  },
  (t) => [check("hosts_json", sql`json_valid(${t.data})`)],
);
export const repositories = sqliteTable("repositories", {
  path: text().primaryKey().notNull(),
  registration: text().unique(),
});
export const worktrees = sqliteTable(
  "worktrees",
  {
    path: text().primaryKey().notNull(),
    repository: text()
      .notNull()
      .references(() => repositories.path, { onDelete: "restrict" }),
    data: text().notNull(),
  },
  (t) => [
    index("worktrees_repository").on(t.repository),
    check("worktrees_json", sql`json_valid(${t.data})`),
  ],
);
// Remote repositories/checkout inventories belong to foom-host, not the hub.
// Remote sessions reference their saved registration; paths remain validated claims.
// Home/config sessions and unmanaged Git checkouts need no fabricated owned row.
export const sessions = sqliteTable(
  "sessions",
  {
    id: text().primaryKey().notNull(),
    host: text().references(() => hosts.alias, { onDelete: "restrict" }),
    repository: text().references(() => repositories.path, { onDelete: "restrict" }),
    worktree: text().references(() => worktrees.path, { onDelete: "restrict" }),
    parent: text().references((): AnySQLiteColumn => sessions.id, { onDelete: "restrict" }),
    kind: text().notNull(),
    data: text().notNull(),
  },
  (t) => [
    index("sessions_host").on(t.host),
    index("sessions_repository").on(t.repository),
    index("sessions_worktree").on(t.worktree),
    index("sessions_parent").on(t.parent),
    check("sessions_kind", sql`${t.kind} IN ('local', 'remote', 'home', 'config')`),
    check("sessions_placement", sql`(${t.kind} = 'remote') = (${t.host} IS NOT NULL)`),
    check("sessions_local_repository", sql`${t.kind} != 'local' OR ${t.repository} IS NOT NULL`),
    check("sessions_parent_self", sql`${t.parent} IS NULL OR ${t.parent} != ${t.id}`),
    check("sessions_json", sql`json_valid(${t.data})`),
  ],
);
export const ownedWorktrees = sqliteTable(
  "owned_worktrees",
  {
    path: text()
      .primaryKey()
      .notNull()
      .references(() => worktrees.path, { onDelete: "restrict" }),
    owner: text()
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    state: text().notNull(),
    data: text().notNull(),
  },
  (t) => [
    index("owned_worktrees_owner").on(t.owner),
    check("owned_worktrees_state", sql`${t.state} IN ('unused', 'used')`),
    check("owned_worktrees_json", sql`json_valid(${t.data})`),
  ],
);
export const pendingRemovals = sqliteTable(
  "pending_removals",
  {
    path: text().primaryKey().notNull(),
    repository: text()
      .notNull()
      .references(() => repositories.path, { onDelete: "restrict" }),
    data: text().notNull(),
  },
  (t) => [
    index("pending_removals_repository").on(t.repository),
    check("pending_removals_json", sql`json_valid(${t.data})`),
  ],
);
export const worktreeParents = sqliteTable("worktree_parents", {
  path: text().primaryKey().notNull(),
  identity: text().notNull(),
});
export const quarantine = sqliteTable(
  "quarantine",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    source: text().notNull(),
    position: integer().notNull(),
    reason: text().notNull(),
    // Original bytes stay in private recovery files, never in the change log/report.
  },
  (t) => [check("quarantine_reason", sql`${t.reason} IN ('invalid', 'relationship', 'conflict')`)],
);
export const imports = sqliteTable("_imports", {
  name: text().primaryKey().notNull(),
  report: text().notNull(),
});
export const changes = sqliteTable("_changes", {
  revision: integer().primaryKey({ autoIncrement: true }),
  tableName: text("table_name").notNull(),
});
