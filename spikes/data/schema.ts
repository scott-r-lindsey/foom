import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Drizzle has no STRICT table option in rc.5. The reviewed generated migration
// adds STRICT to each CREATE TABLE; the runner checks the live schema.
export const hosts = sqliteTable("hosts", {
  id: text().primaryKey().notNull(),
  name: text().notNull(),
});
export const repositories = sqliteTable("repositories", {
  id: text().primaryKey().notNull(),
  hostId: text("host_id").notNull().references(() => hosts.id, { onDelete: "restrict" }),
}, (t) => [index("repositories_host").on(t.hostId)]);
export const worktrees = sqliteTable("worktrees", {
  id: text().primaryKey().notNull(),
  repositoryId: text("repository_id").notNull().references(() => repositories.id, { onDelete: "restrict" }),
}, (t) => [index("worktrees_repository").on(t.repositoryId)]);
export const sessions = sqliteTable("sessions", {
  id: integer().primaryKey(),
  worktreeId: text("worktree_id").notNull().references(() => worktrees.id, { onDelete: "restrict" }),
  state: text().notNull(),
}, (t) => [
  index("sessions_worktree").on(t.worktreeId),
  check("session_state", sql`${t.state} IN ('running', 'exited')`),
]);
export const changes = sqliteTable("_changes", {
  revision: integer().primaryKey({ autoIncrement: true }),
  tableName: text("table_name").notNull(),
});
