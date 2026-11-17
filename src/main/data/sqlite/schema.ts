import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  blob,
  primaryKey,
  foreignKey,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
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
export const repositories = sqliteTable(
  "repositories",
  {
    path: text().primaryKey().notNull(),
    registration: text().unique(),
  },
  (t) => [uniqueIndex("repositories_registration_identity").on(t.path, t.registration)],
);
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

export const profileSettings = sqliteTable(
  "profile_settings",
  {
    key: text().primaryKey().notNull(),
    value: text().notNull(),
  },
  (t) => [
    check(
      "profile_settings_key",
      sql`${t.key} IN ('setupComplete','checkForUpdates','agyPluginOfferAnswered','hooks','agentHooks','restoreSessions','showNewChildren','closeFinishedAgents','wakeOrchestrator','wakeIntervalMinutes','concurrentChildren','defaultAgent','recentRepositoryDays','unreadChildMinutes','autoRemoveMergedWorktrees','showPullRequests','showNestedRepositoryNames','middleClickPaste','copyOnSelect','terminalClipboardWrites','forges','forgeHosts','agents','agentArguments','worktreeLocation','panelColor','interfaceTheme','interfaceScale','terminalFontSize','terminalFont','terminalTheme','sound','codeFolder')`,
    ),
    check("profile_settings_json", sql`json_valid(${t.value})`),
    check(
      "profile_settings_boolean",
      sql`${t.key} NOT IN ('setupComplete','checkForUpdates','agyPluginOfferAnswered','hooks','restoreSessions','showNewChildren','closeFinishedAgents','wakeOrchestrator','autoRemoveMergedWorktrees','showPullRequests','showNestedRepositoryNames','middleClickPaste','copyOnSelect','terminalClipboardWrites') OR json_type(${t.value}) IN ('true','false')`,
    ),
    check(
      "profile_settings_location",
      sql`${t.key} != 'worktreeLocation' OR COALESCE(json_extract(${t.value}, '$') IN ('root','adjacent'), 0)`,
    ),
    check(
      "profile_settings_panel",
      sql`${t.key} != 'panelColor' OR COALESCE(json_extract(${t.value}, '$') IN ('vivid','subtle','plain'), 0)`,
    ),
  ],
);
export const agentConsents = sqliteTable(
  "agent_consents",
  {
    agent: text().primaryKey().notNull(),
    acknowledged: integer().notNull(),
    identity: text(),
  },
  (t) => [
    check("agent_consents_boolean", sql`${t.acknowledged} IN (0,1)`),
    check(
      "agent_consents_identity",
      sql`${t.identity} IS NULL OR (length(${t.identity})=64 AND ${t.identity} NOT GLOB '*[^a-f0-9]*')`,
    ),
  ],
);
export const profileMetadata = sqliteTable(
  "profile_metadata",
  {
    key: text().primaryKey().notNull(),
    value: text().notNull(),
  },
  (t) => [
    check(
      "profile_metadata_key",
      sql`${t.key} IN ('remoteProfile','configVersion','configDigest','configText','themeDigests')`,
    ),
    check("profile_metadata_json", sql`json_valid(${t.value})`),
  ],
);
export const environmentScopes = sqliteTable("environment_scopes", {
  scope: text().primaryKey().notNull(),
});
export const environmentEntries = sqliteTable(
  "environment_entries",
  {
    scope: text()
      .notNull()
      .references(() => environmentScopes.scope, { onDelete: "restrict" }),
    fold: text().notNull(),
    name: text().notNull(),
    secret: integer().notNull(),
    value: text(),
    cipher: blob({ mode: "buffer" }),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.fold] }),
    check("environment_secret", sql`${t.secret} IN (0,1)`),
    check(
      "environment_storage",
      sql`(${t.secret}=1 AND ${t.value} IS NULL AND ${t.cipher} IS NOT NULL AND length(${t.cipher}) BETWEEN 1 AND 16384) OR (${t.secret}=0 AND ${t.value} IS NOT NULL AND ${t.cipher} IS NULL AND length(${t.value})<=4096)`,
    ),
    check("environment_name", sql`length(${t.name}) BETWEEN 1 AND 256`),
  ],
);

export const boardThreads = sqliteTable(
  "board_threads",
  {
    id: text().primaryKey().notNull(),
    state: text().notNull(),
    removedAt: text("removed_at"),
    data: text().notNull(),
  },
  (t) => [
    check(
      "board_thread_state",
      sql`${t.state} IN ('open','waiting-repo','waiting-human','resolved')`,
    ),
    check("board_thread_json", sql`json_valid(${t.data})`),
    index("board_thread_removal").on(t.removedAt),
  ],
);
export const boardPosts = sqliteTable(
  "board_posts",
  {
    id: text().primaryKey().notNull(),
    thread: text()
      .notNull()
      .references(() => boardThreads.id, { onDelete: "restrict" }),
    kind: text().notNull(),
    data: text().notNull(),
  },
  (t) => [
    index("board_posts_thread").on(t.thread),
    uniqueIndex("board_post_identity").on(t.id, t.thread),
    check("board_post_kind", sql`${t.kind} IN ('request','answer','decision-needed','fyi','link')`),
    check("board_post_json", sql`json_valid(${t.data})`),
  ],
);
export const boardRecipients = sqliteTable(
  "board_recipients",
  {
    thread: text()
      .notNull()
      .references(() => boardThreads.id, { onDelete: "restrict" }),
    repositorySnapshot: text("repository_snapshot").notNull(),
  },
  (t) => [primaryKey({ columns: [t.thread, t.repositorySnapshot] })],
);
export const boardBindings = sqliteTable(
  "board_bindings",
  {
    thread: text()
      .notNull()
      .references(() => boardThreads.id, { onDelete: "restrict" }),
    repository: text()
      .notNull()
      .references(() => repositories.path, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({ columns: [t.thread, t.repository] }),
    index("board_bindings_repository").on(t.repository),
  ],
);
export const boardReceipts = sqliteTable(
  "board_receipts",
  {
    scope: text().notNull(),
    key: text().notNull(),
    hash: text().notNull(),
    thread: text()
      .notNull()
      .references(() => boardThreads.id, { onDelete: "restrict" }),
    post: text(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.key] }),
    index("board_receipts_thread").on(t.thread),
    index("board_receipts_post").on(t.post, t.thread),
    foreignKey({
      columns: [t.post, t.thread],
      foreignColumns: [boardPosts.id, boardPosts.thread],
    }).onDelete("restrict"),
  ],
);
export const forgeObservations = sqliteTable(
  "forge_observations",
  {
    path: text().primaryKey().notNull(),
    host: text().references(() => hosts.alias, { onDelete: "restrict" }),
    repository: text().references(() => repositories.path, { onDelete: "restrict" }),
    worktree: text().references(() => worktrees.path, { onDelete: "restrict" }),
    data: text().notNull(),
  },
  (t) => [
    index("forge_host").on(t.host),
    index("forge_repository").on(t.repository),
    index("forge_worktree").on(t.worktree),
    check("forge_observations_json", sql`json_valid(${t.data})`),
  ],
);
export const offers = sqliteTable(
  "offers",
  {
    category: text().notNull(),
    agent: text().notNull(),
    answered: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.category, t.agent] }),
    check("offer_category", sql`${t.category} IN ('setup','probe-notice')`),
    check("offer_answer", sql`${t.answered} IN (0,1)`),
  ],
);
export const agentHealth = sqliteTable(
  "agent_health",
  {
    namespace: text().notNull(),
    agent: text().notNull(),
    fingerprint: text().notNull(),
    state: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.namespace, t.agent] }),
    check("health_state", sql`${t.state} IN ('trusted','declined','outdated','not-reviewed')`),
    check(
      "health_fingerprint",
      sql`length(${t.fingerprint})=64 AND ${t.fingerprint} NOT GLOB '*[^a-f0-9]*'`,
    ),
  ],
);
export const controlOperations = sqliteTable(
  "control_operations",
  {
    id: text().primaryKey().notNull(),
    action: text().notNull(),
    status: text().notNull(),
    keyHash: text("key_hash").notNull(),
    fingerprint: text().notNull(),
    generation: text().notNull(),
    recovered: integer().notNull(),
    data: text().notNull(),
  },
  (t) => [
    uniqueIndex("operation_generation_key").on(t.generation, t.keyHash),
    check(
      "operation_action",
      sql`${t.action} IN ('wake','create_worktree','launch','stop','close','remove_worktree','prompt','send_keys','reply','board_post','board_resolve')`,
    ),
    check(
      "operation_status",
      sql`${t.status} IN ('pending_confirmation','running','succeeded','failed','declined','cancelled','indeterminate')`,
    ),
    check("operation_recovered", sql`${t.recovered} IN (0,1)`),
    check("operation_json", sql`json_valid(${t.data})`),
    check(
      "operation_hashes",
      sql`length(${t.keyHash})=64 AND ${t.keyHash} NOT GLOB '*[^a-f0-9]*' AND length(${t.fingerprint})=64 AND ${t.fingerprint} NOT GLOB '*[^a-f0-9]*'`,
    ),
  ],
);
export const auditRecords = sqliteTable(
  "audit_records",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    operationSnapshot: text("operation_snapshot").notNull(),
    timestamp: text().notNull(),
    data: text().notNull(),
  },
  (t) => [
    index("audit_operation").on(t.operationSnapshot),
    index("audit_timestamp").on(t.timestamp),
    check("audit_json", sql`json_valid(${t.data})`),
  ],
);
export const operationAuditLinks = sqliteTable(
  "operation_audit_links",
  {
    operation: text()
      .notNull()
      .references(() => controlOperations.id, { onDelete: "restrict" }),
    audit: integer()
      .notNull()
      .references(() => auditRecords.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({ columns: [t.operation, t.audit] }),
    index("operation_audit_record").on(t.audit),
  ],
);
export const verdictRecords = sqliteTable(
  "verdict_records",
  {
    id: text().primaryKey().notNull(),
    terminalSnapshot: text("terminal_snapshot").notNull(),
    state: text().notNull(),
    timestamp: text().notNull(),
    data: text().notNull(),
  },
  (t) => [
    index("verdict_terminal").on(t.terminalSnapshot),
    check("verdict_state", sql`${t.state} IN ('needs_input','done','failed','quiet_ok','working')`),
    check("verdict_json", sql`json_valid(${t.data})`),
  ],
);
export const verdictActions = sqliteTable(
  "verdict_actions",
  {
    verdict: text()
      .primaryKey()
      .notNull()
      .references(() => verdictRecords.id, { onDelete: "restrict" }),
    action: text().notNull(),
    timestamp: text().notNull(),
  },
  (t) => [check("verdict_action", sql`${t.action} IN ('replied','dismissed','ignored')`)],
);
export const repositoryApprovals = sqliteTable(
  "repository_approvals",
  {
    repository: text().primaryKey().notNull(),
    registration: text().notNull(),
    data: text().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.repository, t.registration],
      foreignColumns: [repositories.path, repositories.registration],
    }).onDelete("restrict"),
    index("approval_registration").on(t.registration),
    check("repository_approval_json", sql`json_valid(${t.data})`),
  ],
);
export const repositoryObservations = sqliteTable(
  "repository_observations",
  {
    repository: text()
      .notNull()
      .references(() => repositories.path, { onDelete: "restrict" }),
    machine: text().notNull(),
    host: text().references(() => hosts.alias, { onDelete: "restrict" }),
    state: text().notNull(),
    data: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.repository, t.machine] }),
    index("repository_observations_host").on(t.host),
    check(
      "repository_observation_state",
      sql`${t.state} IN ('no-list','not-checked','met','needs-setup','review-needed','unable','manual')`,
    ),
    check("repository_observation_json", sql`json_valid(${t.data})`),
  ],
);
export const terminalDiagnostics = sqliteTable(
  "terminal_diagnostics",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    kind: text().notNull(),
    data: text().notNull(),
  },
  (t) => [
    check("terminal_diagnostic_kind", sql`${t.kind} IN ('exit','timeout','near-miss')`),
    check("terminal_diagnostic_json", sql`json_valid(${t.data})`),
  ],
);
