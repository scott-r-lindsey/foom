import { and, eq, lt, lte, or, inArray, notInArray, desc, sql } from "drizzle-orm";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { validForgeTree } from "../../control/forge-tracking";
import { auditEntry } from "../../control/store";
import { forgeBranch, pullRequest } from "../../control/forge";
import { validAgentId } from "../../../shared/providers/catalog";
import { record } from "../../../shared/remote-agent-protocol";
import { identifier, object } from "../../../shared/control-validation";
import { gitOrigin } from "../../../shared/registered-hosts";
import { verifyPrivate } from "../../../node-common/private-files";
import {
  parseSetupList,
  parseSetupListV1,
  setupSources,
  setupSourcePath,
} from "../../../shared/repository-setup";
import { setupDigest, setupCatalogV1Digest } from "../../../node-common/repository-setup-digest";
import { prepareTail } from "../../evaluator/terminal-tail";
import { importBoardRows, pruneBoardRows } from "./board";
import { importLegacyGroup } from "./importer";
import type { LegacyOriginals } from "./importer";
import { LegacyBatch } from "./legacy-batch";
import type { DataTransaction } from "./commands";
import { RelationshipError } from "./commands";
import type { ProfileDatabase } from "./database";
import * as tables from "./schema";

const statuses = [
  "pending_confirmation",
  "running",
  "succeeded",
  "failed",
  "declined",
  "cancelled",
  "indeterminate",
];
const actions = [
  "wake",
  "create_worktree",
  "launch",
  "stop",
  "close",
  "remove_worktree",
  "prompt",
  "send_keys",
  "reply",
  "board_post",
  "board_resolve",
];
function text(value: unknown, maximum = 4096): string {
  if (typeof value !== "string" || value.length > maximum)
    throw new Error("Invalid history metadata");
  return value;
}
function stamp(value: unknown): string {
  const result = text(value, 32);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result)
    throw new Error("Invalid history timestamp");
  return result;
}
function digest(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error("Invalid history digest");
  return result;
}
function numeric(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    throw new Error("Invalid history number");
  return value;
}
function parsed(text: string): unknown {
  const result: unknown = JSON.parse(text);
  return result;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("Invalid history list");
  const rows: unknown[] = value;
  return rows;
}
function knownRepository(db: DataTransaction, value: unknown) {
  const name = text(value);
  const result = db
    .select()
    .from(tables.repositories)
    .all()
    .find(
      (row) =>
        row.path === name ||
        row.registration === name ||
        createHash("sha256").update(row.path).digest("hex") === name,
    );
  if (!result) throw new RelationshipError();
  return result;
}
function forge(input: unknown) {
  const row = object(input);
  const tree = {
    repository: row["repository"],
    path: row["path"],
    identity: row["identity"],
    branch: row["branch"],
    ...(row["remoteCheckout"] === undefined ? {} : { remoteCheckout: row["remoteCheckout"] }),
  };
  if (!validForgeTree(tree)) throw new Error("Invalid forge checkout");
  const pr = row["pr"] === undefined ? undefined : pullRequest(row["pr"]);
  if (row["pr"] !== undefined && !pr) throw new Error("Invalid forge observation");
  const remote = row["remote"] === undefined ? undefined : text(row["remote"]);
  if (remote && !gitOrigin(remote)) throw new Error("Invalid forge remote");
  const number = row["number"] === undefined ? undefined : numeric(row["number"], 1);
  const prBranch = row["prBranch"];
  if (prBranch !== undefined && !forgeBranch(prBranch)) throw new Error("Invalid forge branch");
  if (row["orchestrator"] !== undefined && typeof row["orchestrator"] !== "boolean")
    throw new Error("Invalid forge metadata");
  return {
    ...tree,
    ...(pr ? { pr } : {}),
    ...(remote ? { remote } : {}),
    ...(number ? { number } : {}),
    ...(prBranch === undefined ? {} : { prBranch }),
    ...(row["binding"] === undefined ? {} : { binding: text(row["binding"], 8192) }),
    orchestrator: row["orchestrator"] !== false,
  };
}
function writeForge(db: DataTransaction, value: ReturnType<typeof forge>, replace = false): void {
  const host = value.remoteCheckout?.host ?? null;
  const repository = host ? null : knownRepository(db, value.repository).path;
  const managed = host
    ? undefined
    : db.select().from(tables.worktrees).where(eq(tables.worktrees.path, value.path)).get();
  if (managed && managed.repository !== repository) throw new RelationshipError();
  const row = {
    path: value.path,
    host,
    repository,
    worktree: managed?.path ?? null,
    data: JSON.stringify(value),
  };
  if (replace)
    db.insert(tables.forgeObservations)
      .values(row)
      .onConflictDoUpdate({ target: tables.forgeObservations.path, set: row })
      .run();
  else db.insert(tables.forgeObservations).values(row).run();
}
export function saveDatabaseForgeObservation(database: ProfileDatabase, input: unknown) {
  return database.write((db) => {
    writeForge(db, forge(input), true);
  });
}
export function forgetDatabaseRepository(database: ProfileDatabase, path: string) {
  return database.write((db) => {
    const owner = knownRepository(db, path);
    if (db.select().from(tables.sessions).where(eq(tables.sessions.repository, owner.path)).get())
      throw new Error("Repository still has saved sessions");
    db.delete(tables.boardBindings).where(eq(tables.boardBindings.repository, owner.path)).run();
    db.delete(tables.repositoryApprovals)
      .where(eq(tables.repositoryApprovals.repository, owner.path))
      .run();
    db.delete(tables.repositoryObservations)
      .where(eq(tables.repositoryObservations.repository, owner.path))
      .run();
    db.delete(tables.forgeObservations)
      .where(eq(tables.forgeObservations.repository, owner.path))
      .run();
    db.delete(tables.pendingRemovals)
      .where(eq(tables.pendingRemovals.repository, owner.path))
      .run();
    db.delete(tables.previewRecords)
      .where(
        inArray(
          tables.previewRecords.worktree,
          db
            .select({ path: tables.worktrees.path })
            .from(tables.worktrees)
            .where(eq(tables.worktrees.repository, owner.path)),
        ),
      )
      .run();
    db.delete(tables.worktrees).where(eq(tables.worktrees.repository, owner.path)).run();
    db.delete(tables.repositories).where(eq(tables.repositories.path, owner.path)).run();
  });
}
export function saveDatabaseAgentHealth(
  database: ProfileDatabase,
  namespace: string,
  agent: string,
  fingerprint: string,
  state: string,
) {
  return database.write((db) => {
    if (
      !/^(?:legacy|foom-observers--?[0-9]+)$/u.test(namespace) ||
      !validAgentId(agent) ||
      !["trusted", "declined", "outdated", "not-reviewed"].includes(state)
    )
      throw new Error("Invalid agent observation");
    const row = { namespace, agent, fingerprint: digest(fingerprint), state };
    db.insert(tables.agentHealth)
      .values(row)
      .onConflictDoUpdate({
        target: [tables.agentHealth.namespace, tables.agentHealth.agent],
        set: row,
      })
      .run();
  });
}
export function answerDatabaseOffer(
  database: ProfileDatabase,
  category: "setup" | "probe-notice",
  agent: string,
  answered: boolean,
) {
  return database.write((db) => {
    if (
      !["setup", "probe-notice"].includes(category) ||
      !validAgentId(agent) ||
      typeof answered !== "boolean"
    )
      throw new Error("Invalid offer");
    db.insert(tables.offers)
      .values({ category, agent, answered: Number(answered) })
      .onConflictDoUpdate({
        target: [tables.offers.category, tables.offers.agent],
        set: { answered: Number(answered) },
      })
      .run();
  });
}
function operation(input: unknown, recovered: boolean) {
  const row = object(input);
  const actor = object(row["actor"]);
  const value = object(row["operation"]);
  const action = text(value["action"], 64);
  const before = text(value["status"], 64);
  if (!actions.includes(action) || !statuses.includes(before))
    throw new Error("Invalid control operation");
  const id = identifier(value["operationId"]);
  const generation = identifier(actor["generation"]);
  if (!["agent", "orchestrator", "cli"].includes(text(actor["role"], 16)))
    throw new Error("Invalid operation actor");
  stamp(actor["grantedAt"]);
  stamp(value["createdAt"]);
  stamp(value["updatedAt"]);
  const status =
    recovered && ["pending_confirmation", "running"].includes(before) ? "indeterminate" : before;
  const safe = auditEntry({
    ...value,
    actor,
    timestamp: value["updatedAt"],
    status,
    ...(recovered ? { reason: "recovery" } : {}),
  });
  return {
    id,
    action,
    status,
    keyHash: digest(row["key"]),
    fingerprint: digest(row["fingerprint"]),
    generation,
    recovered: Number(recovered),
    data: JSON.stringify({
      ...safe,
      createdAt: stamp(value["createdAt"]),
      updatedAt: stamp(value["updatedAt"]),
    }),
  };
}
function writeAudit(db: DataTransaction, input: unknown, prune = true): number {
  const validated = auditEntry(input);
  const entry = {
    ...validated,
    timestamp: prune ? new Date().toISOString() : new Date(validated.timestamp).toISOString(),
  };
  const result = db
    .insert(tables.auditRecords)
    .values({
      operationSnapshot: entry.operationId,
      timestamp: entry.timestamp,
      data: JSON.stringify(entry),
    })
    .returning({ id: tables.auditRecords.id })
    .get();
  if (
    db
      .select()
      .from(tables.controlOperations)
      .where(eq(tables.controlOperations.id, entry.operationId))
      .get()
  )
    db.insert(tables.operationAuditLinks)
      .values({ operation: entry.operationId, audit: result.id })
      .run();
  if (prune) pruneAudit(db, Date.now(), 50 * 1024 * 1024);
  return result.id;
}
export function reserveDatabaseOperation(database: ProfileDatabase, input: unknown) {
  return database.write((db) => {
    const value = operation(input, false);
    if (!["pending_confirmation", "running"].includes(value.status))
      throw new Error("Intent must precede effects");
    const previous = db
      .select()
      .from(tables.controlOperations)
      .where(
        and(
          eq(tables.controlOperations.generation, value.generation),
          eq(tables.controlOperations.keyHash, value.keyHash),
        ),
      )
      .get();
    if (previous) {
      if (previous.recovered || previous.fingerprint !== value.fingerprint)
        throw new Error("Operation conflict");
      return { operationId: previous.id, created: false };
    }
    db.insert(tables.controlOperations).values(value).run();
    writeAudit(db, parsed(value.data));
    return { operationId: value.id, created: true };
  });
}
export function finishDatabaseOperation(
  database: ProfileDatabase,
  id: string,
  status: string,
  reason: string,
) {
  return database.write((db) => {
    if (!statuses.includes(status) || status === "pending_confirmation")
      throw new Error("Invalid operation transition");
    const previous = db
      .select()
      .from(tables.controlOperations)
      .where(eq(tables.controlOperations.id, identifier(id)))
      .get();
    if (!previous || previous.recovered) throw new Error("No live operation");
    if (!["pending_confirmation", "running"].includes(previous.status))
      throw new Error("Operation already finished");
    const before = object(parsed(previous.data));
    const updatedAt = new Date().toISOString();
    const after = auditEntry({ ...before, status, reason, timestamp: updatedAt });
    db.update(tables.controlOperations)
      .set({
        status,
        data: JSON.stringify({ ...after, createdAt: stamp(before["createdAt"]), updatedAt }),
      })
      .where(eq(tables.controlOperations.id, id))
      .run();
    writeAudit(db, after);
  });
}
export function appendDatabaseAudit(database: ProfileDatabase, input: unknown) {
  return database.write((db) => writeAudit(db, input));
}
function pruneAudit(db: DataTransaction, now: number, budget: number): number {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(budget) || now < 0 || budget < 1)
    throw new Error("Invalid audit retention");
  const cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const expired = lt(tables.auditRecords.timestamp, cutoff);
  db.delete(tables.operationAuditLinks)
    .where(
      inArray(
        tables.operationAuditLinks.audit,
        db.select({ id: tables.auditRecords.id }).from(tables.auditRecords).where(expired),
      ),
    )
    .run();
  let removed = Number(db.delete(tables.auditRecords).where(expired).run().changes);
  const aggregate: unknown = db.get(
    sql`SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) AS bytes FROM audit_records`,
  );
  const bytes = object(aggregate)["bytes"];
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes))
    throw new Error("Invalid audit size");
  if (bytes <= budget) return removed;
  let retained = bytes;
  for (const raw of db.all(
    sql`SELECT id,timestamp,length(CAST(data AS BLOB)) AS bytes FROM audit_records ORDER BY timestamp,id`,
  )) {
    const row = object(raw);
    const size = numeric(row["bytes"]);
    const id = numeric(row["id"], 1);
    const timestamp = stamp(row["timestamp"]);
    retained -= size;
    if (retained > budget) continue;
    const oldest = or(
      lt(tables.auditRecords.timestamp, timestamp),
      and(eq(tables.auditRecords.timestamp, timestamp), lte(tables.auditRecords.id, id)),
    );
    db.delete(tables.operationAuditLinks)
      .where(
        inArray(
          tables.operationAuditLinks.audit,
          db.select({ id: tables.auditRecords.id }).from(tables.auditRecords).where(oldest),
        ),
      )
      .run();
    removed += Number(db.delete(tables.auditRecords).where(oldest).run().changes);
    break;
  }
  return removed;
}
export function pruneDatabaseAudit(
  database: ProfileDatabase,
  now = Date.now(),
  budget = 50 * 1024 * 1024,
) {
  return database.write((db) => pruneAudit(db, now, budget));
}
export function clearDatabaseAudit(database: ProfileDatabase) {
  return database.write((db) => {
    db.delete(tables.operationAuditLinks).run();
    db.delete(tables.auditRecords).run();
  });
}
export function retireDatabaseOperation(database: ProfileDatabase, id: string) {
  return database.write((db) => {
    identifier(id);
    db.delete(tables.operationAuditLinks).where(eq(tables.operationAuditLinks.operation, id)).run();
    db.delete(tables.controlOperations).where(eq(tables.controlOperations.id, id)).run();
  });
}
function verdict(input: unknown) {
  const row = object(input);
  const value = object(row["verdict"]);
  const state = text(value["state"], 32);
  if (
    !["needs_input", "done", "failed", "quiet_ok", "working"].includes(state) ||
    typeof value["confidence"] !== "number" ||
    !Number.isFinite(value["confidence"]) ||
    value["confidence"] < 0 ||
    value["confidence"] > 1
  )
    throw new Error("Invalid verdict");
  const attention = value["attentionKind"];
  if (
    attention !== undefined &&
    !["question", "permission", "credential", "provider", "unknown"].includes(text(attention, 32))
  )
    throw new Error("Invalid attention kind");
  return {
    id: identifier(row["id"]),
    terminalId: identifier(row["terminalId"]),
    timestamp: stamp(row["timestamp"]),
    verdict: {
      state,
      confidence: value["confidence"],
      reason: prepareTail([text(value["reason"])]),
      signal: prepareTail([text(value["signal"])]),
      ...(attention === undefined ? {} : { attentionKind: attention }),
    },
  };
}
export function saveDatabaseVerdict(database: ProfileDatabase, input: unknown) {
  return database.write((db) => {
    const row = verdict(input);
    db.insert(tables.verdictRecords)
      .values({
        id: row.id,
        terminalSnapshot: row.terminalId,
        state: row.verdict.state,
        timestamp: row.timestamp,
        data: JSON.stringify(row),
      })
      .run();
  });
}
export function feedbackDatabaseVerdict(database: ProfileDatabase, input: unknown) {
  return database.write((db) => {
    writeFeedback(db, input);
  });
}
function writeFeedback(db: DataTransaction, input: unknown): void {
  const row = object(input);
  const id = identifier(row["verdictId"]);
  const terminal = identifier(row["terminalId"]);
  const action = text(row["action"], 32);
  if (!["replied", "dismissed", "ignored"].includes(action))
    throw new Error("Invalid verdict action");
  const parent = db
    .select()
    .from(tables.verdictRecords)
    .where(eq(tables.verdictRecords.id, id))
    .get();
  if (!parent || parent.terminalSnapshot !== terminal) throw new RelationshipError();
  db.insert(tables.verdictActions)
    .values({ verdict: id, action, timestamp: stamp(row["timestamp"]) })
    .run();
}
export function forgetDatabaseVerdict(database: ProfileDatabase, id: string) {
  return database.write((db) => {
    identifier(id);
    db.delete(tables.verdictActions).where(eq(tables.verdictActions.verdict, id)).run();
    db.delete(tables.verdictRecords).where(eq(tables.verdictRecords.id, id)).run();
  });
}
function approval(db: DataTransaction, input: unknown) {
  const raw = object(input);
  const owner = knownRepository(db, raw["repository"]);
  if (!owner.registration || raw["identity"] !== owner.registration) throw new RelationshipError();
  const catalog = digest(raw["catalog"]);
  const requirements = (catalog === setupCatalogV1Digest ? parseSetupListV1 : parseSetupList)(
    JSON.stringify(raw["list"]),
  );
  if (
    digest(raw["digest"]) !== setupDigest(requirements) ||
    !setupSources(raw["sources"]) ||
    raw["sources"].fingerprint !== setupDigest(raw["sources"].files)
  )
    throw new Error("Invalid approval evidence");
  const data = {
    repository: text(raw["repository"]),
    identity: owner.registration,
    revision: numeric(raw["revision"], 1),
    digest: raw["digest"],
    catalog,
    sources: raw["sources"],
    checkout: text(raw["checkout"]),
    head: text(raw["head"], 64),
    approvedAt: numeric(raw["approvedAt"]),
    list: requirements,
  };
  return { repository: owner.path, registration: owner.registration, data: JSON.stringify(data) };
}
function observation(db: DataTransaction, input: unknown) {
  const raw = object(input);
  const owner = knownRepository(db, raw["repository"]);
  const host = raw["host"] === null ? null : text(raw["host"], 253);
  const state = text(raw["state"], 32);
  if (
    !["no-list", "not-checked", "met", "needs-setup", "review-needed", "unable", "manual"].includes(
      state,
    ) ||
    typeof raw["sourcesAtLaunch"] !== "boolean"
  )
    throw new Error("Invalid setup observation");
  const missing = list(raw["missing"], 128).map((id) => {
    const value = text(id, 64);
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(value)) throw new Error("Invalid setup requirement");
    return value;
  });
  const changed = list(raw["changed"], 64).map((path) => {
    if (!setupSourcePath(path)) throw new Error("Invalid setup source");
    return path;
  });
  return {
    repository: owner.path,
    machine: host === null ? "local" : `host:${host}`,
    host,
    state,
    data: JSON.stringify({
      repository: raw["repository"],
      host,
      state,
      revision: numeric(raw["revision"]),
      missing,
      changed,
      sourcesAtLaunch: raw["sourcesAtLaunch"],
      ...(raw["checkedAt"] === undefined ? {} : { checkedAt: numeric(raw["checkedAt"], 1) }),
    }),
  };
}
export function saveDatabaseApproval(database: ProfileDatabase, input: unknown) {
  return database.write((db) => {
    const row = approval(db, input);
    db.insert(tables.repositoryApprovals)
      .values(row)
      .onConflictDoUpdate({ target: tables.repositoryApprovals.repository, set: row })
      .run();
  });
}
export function saveDatabaseSetupObservation(database: ProfileDatabase, input: unknown) {
  return database.write((db) => {
    const row = observation(db, input);
    db.insert(tables.repositoryObservations)
      .values(row)
      .onConflictDoUpdate({
        target: [tables.repositoryObservations.repository, tables.repositoryObservations.machine],
        set: row,
      })
      .run();
  });
}
function metadataDiagnostic(input: unknown, kind: string) {
  const row = object(input);
  const time = stamp(row["time"]);
  const count = (key: string) => (row[key] == null ? null : numeric(row[key]));
  if (kind === "near-miss") {
    const name = text(row["kind"], 32);
    if (!["late-reply", "late-drain", "late-turn"].includes(name))
      throw new Error("Invalid host observation");
    return {
      time,
      kind: name,
      replyLatencyMs: count("replyLatencyMs"),
      probeElapsedMs: count("probeElapsedMs"),
      lateCycles: count("lateCycles"),
      mainLagMs: count("mainLagMs"),
    };
  }
  // These snapshots contain numeric host health, never terminal screens.
  if (kind === "timeout") {
    const command = text(row["command"], 32);
    if (
      ![
        "create",
        "theme",
        "attach",
        "detach",
        "kill",
        "stop",
        "shutdown",
        "screen",
        "write",
        "child-input",
        "wake-input",
        "resize",
        "acknowledge",
        "tail",
        "ping",
      ].includes(command)
    )
      throw new Error("Invalid timeout command");
    return { time, command, elapsedMs: numeric(row["elapsedMs"]) };
  }
  const cause = row["cause"];
  if (cause !== undefined && !["watchdog-kill", "foom-kill", "host-exit"].includes(text(cause, 32)))
    throw new Error("Invalid exit cause");
  const snapshot = row["snapshot"] === undefined ? undefined : object(row["snapshot"]);
  const field = (value: Record<string, unknown>, key: string) =>
    value[key] == null ? null : numeric(value[key]);
  const gone = row["gone"] === undefined ? undefined : object(row["gone"]);
  return {
    time,
    reason: prepareTail([text(row["reason"], 256)]),
    serviceName: text(row["serviceName"], 128),
    pid: count("pid"),
    exitCode: row["exitCode"] == null ? null : numeric(row["exitCode"], -2147483648),
    ...(cause === undefined ? {} : { cause }),
    ...(snapshot
      ? {
          snapshot: {
            liveTerminals: field(snapshot, "liveTerminals"),
            hostMemoryKB: field(snapshot, "hostMemoryKB"),
            lastMessageAgeMs: field(snapshot, "lastMessageAgeMs"),
            mainLagMs: field(snapshot, "mainLagMs"),
          },
        }
      : {}),
    ...(gone
      ? {
          gone: {
            type: text(gone["type"], 64),
            reason: prepareTail([text(gone["reason"], 256)]),
            exitCode: numeric(gone["exitCode"], -2147483648),
          },
        }
      : {}),
  };
}
function trimDiagnostics(db: DataTransaction): void {
  for (const kind of ["exit", "timeout", "near-miss"]) {
    const ids = db
      .select({ id: tables.terminalDiagnostics.id })
      .from(tables.terminalDiagnostics)
      .where(eq(tables.terminalDiagnostics.kind, kind))
      .orderBy(desc(tables.terminalDiagnostics.id))
      .limit(kind === "exit" ? 32 : 16);
    db.delete(tables.terminalDiagnostics)
      .where(
        and(
          eq(tables.terminalDiagnostics.kind, kind),
          notInArray(tables.terminalDiagnostics.id, ids),
        ),
      )
      .run();
  }
}
export function appendDatabaseHostDiagnostic(
  database: ProfileDatabase,
  kind: string,
  input: unknown,
) {
  return database.write((db) => {
    if (!["exit", "timeout", "near-miss"].includes(kind))
      throw new Error("Invalid host diagnostic kind");
    const value = metadataDiagnostic(input, kind);
    db.insert(tables.terminalDiagnostics)
      .values({ kind, data: JSON.stringify(value) })
      .run();
    trimDiagnostics(db);
  });
}
export function importControlRows(db: DataTransaction, input: LegacyOriginals) {
  const batch = new LegacyBatch(db);
  const files = Object.entries(input);
  const parse = (source: string, text: string | null) => {
    if (text === null) return undefined;
    try {
      return parsed(text);
    } catch {
      batch.reject(source, -1);
      return undefined;
    }
  };
  const board = input["control/board.json"];
  const boardReport = importBoardRows(db, board);
  batch.accepted += boardReport.accepted;
  batch.quarantined += boardReport.quarantined;
  const forgeData = parse("control/forge.json", input["control/forge.json"] ?? null);
  if (forgeData !== undefined) {
    const entries = Array.isArray(forgeData)
      ? forgeData
      : object(forgeData)["version"] === 1
        ? object(forgeData)["entries"]
        : undefined;
    if (!Array.isArray(entries) || entries.length > 1000) batch.reject("control/forge.json", -1);
    else
      for (const [position, row] of entries.entries())
        batch.row(
          "control/forge.json",
          position,
          () => forge(row),
          (value) => {
            writeForge(db, value);
          },
        );
  }
  for (const [source, content] of files.filter(([source]) =>
    /^control\/operation-[a-f0-9-]{36}\.json$/u.test(source),
  )) {
    const data = parse(source, content);
    if (data === undefined) continue;
    batch.row(
      "control/operations",
      files.findIndex(([name]) => name === source),
      () => operation(data, true),
      (value) => {
        if (value.id !== source.slice("control/operation-".length, -5))
          throw new RelationshipError();
        db.insert(tables.controlOperations).values(value).run();
        if (value.status === "indeterminate")
          writeAudit(
            db,
            {
              ...object(parsed(value.data)),
              timestamp: new Date().toISOString(),
              reason: "recovery",
            },
            false,
          );
      },
    );
  }
  for (const [source, content] of files.filter(([source]) =>
    /^control\/actions-[0-4]\.jsonl$/u.test(source),
  )) {
    if (content === null) continue;
    for (const [position, line] of content.split("\n").entries())
      if (line)
        batch.row(
          source,
          position,
          () => auditEntry(parsed(line)),
          (entry) => {
            writeAudit(db, entry, false);
          },
        );
  }
  for (const [source, category, maximum] of [
    ["agent-setup/offers.json", "setup", 100],
    ["probe-notices/seen.json", "probe-notice", 1000],
  ] as const) {
    const data = parse(source, input[source] ?? null);
    if (data === undefined) continue;
    if (!Array.isArray(data) || data.length > maximum) {
      batch.reject(source, -1);
      continue;
    }
    for (const [position, agent] of data.entries())
      batch.row(
        source,
        position,
        () => {
          if (!validAgentId(agent)) throw new Error("Invalid offer agent");
          return agent;
        },
        (agent) => {
          db.insert(tables.offers).values({ category, agent, answered: 1 }).run();
        },
      );
  }
  const rows = input["verdicts.jsonl"]?.split("\n").filter(Boolean) ?? [];
  const verdictData = rows.map((line) => parse("verdicts.jsonl", line));
  for (const [position, data] of verdictData.entries()) {
    if (record(data) && data["type"] === "action") continue;
    if (data !== undefined)
      batch.row(
        "verdicts.jsonl",
        position,
        () => {
          if (!record(data) || data["type"] !== "verdict")
            throw new Error("Invalid verdict record");
          return verdict(data);
        },
        (row) => {
          db.insert(tables.verdictRecords)
            .values({
              id: row.id,
              terminalSnapshot: row.terminalId,
              state: row.verdict.state,
              timestamp: row.timestamp,
              data: JSON.stringify(row),
            })
            .run();
        },
      );
  }
  for (const [position, data] of verdictData.entries()) {
    if (record(data) && data["type"] === "action")
      batch.row(
        "verdicts.jsonl",
        position,
        () => data,
        (row) => {
          writeFeedback(db, row);
        },
      );
  }
  const setup = parse("repository-setup/state.json", input["repository-setup/state.json"] ?? null);
  if (setup !== undefined) {
    if (!record(setup) || setup["version"] !== 1)
      throw new Error("Unsupported legacy repository setup version");
    for (const name of ["approvals", "rows"] as const) {
      const entries = setup[name];
      if (!Array.isArray(entries) || entries.length > (name === "approvals" ? 256 : 4096)) {
        batch.reject(`repository-setup/state.json#${name}`, -1);
        continue;
      }
      for (const [position, entry] of entries.entries())
        if (name === "approvals")
          batch.row(
            "repository-setup/state.json#approvals",
            position,
            () => approval(db, entry),
            (row) => {
              db.insert(tables.repositoryApprovals).values(row).run();
            },
          );
        else
          batch.row(
            "repository-setup/state.json#rows",
            position,
            () => observation(db, entry),
            (row) => {
              db.insert(tables.repositoryObservations).values(row).run();
            },
          );
    }
  }
  for (const [source, content] of files.filter(([source]) =>
    /(?:^|\/)[a-z][a-z0-9-]*-(?:hook-)?health\.json$/u.test(source),
  )) {
    const data = parse("agent-health", content);
    if (data === undefined) continue;
    batch.row(
      "agent-health",
      files.findIndex(([name]) => name === source),
      () => {
        const row = object(data);
        const state = text(row["state"], 32);
        if (!["trusted", "declined", "outdated", "not-reviewed"].includes(state))
          throw new Error("Invalid health state");
        const agent =
          source
            .split("/")
            .at(-1)
            ?.replace(/-(?:hook-)?health\.json$/u, "") ?? "";
        if (!validAgentId(agent)) throw new Error("Invalid health agent");
        return {
          namespace: source.includes("/") ? source.slice(0, source.lastIndexOf("/")) : "legacy",
          agent,
          fingerprint: digest(row["fingerprint"]),
          state,
        };
      },
      (row) => {
        db.insert(tables.agentHealth).values(row).run();
      },
    );
  }
  const diagnostics = parse(
    "terminal-host-diagnostics/exits.json",
    input["terminal-host-diagnostics/exits.json"] ?? null,
  );
  if (diagnostics !== undefined) {
    const data = Array.isArray(diagnostics)
      ? { exits: diagnostics, timeouts: [], nearMisses: [] }
      : object(diagnostics);
    for (const [name, kind, maximum] of [
      ["exits", "exit", 32],
      ["timeouts", "timeout", 16],
      ["nearMisses", "near-miss", 16],
    ] as const) {
      const entries = data[name] ?? [];
      if (!Array.isArray(entries) || entries.length > maximum) {
        batch.reject("terminal-host-diagnostics/exits.json", -1);
        continue;
      }
      for (const [position, entry] of entries.entries())
        batch.row(
          "terminal-host-diagnostics/exits.json",
          position,
          () => metadataDiagnostic(parsed(text(entry, 65536)), kind),
          (value) => {
            db.insert(tables.terminalDiagnostics)
              .values({ kind, data: JSON.stringify(value) })
              .run();
          },
        );
    }
  }
  trimDiagnostics(db);
  const pruned = pruneAudit(db, Date.now(), 50 * 1024 * 1024);
  return { ...batch.report(), pruned, prunedThreads: pruneBoardRows(db, Date.now()) };
}
export function importDatabaseControl(database: ProfileDatabase, profile: string) {
  const core = [
    "control/board.json",
    "control/forge.json",
    "agent-setup/offers.json",
    "probe-notices/seen.json",
    "repository-setup/state.json",
    "verdicts.jsonl",
    "terminal-host-diagnostics/exits.json",
    ...Array.from({ length: 5 }, (_, index) => `control/actions-${String(index)}.jsonl`),
  ];
  return importLegacyGroup(
    database,
    profile,
    "control-history-v1",
    async () => {
      const files = [...core];
      async function names(directory: string) {
        try {
          if (directory) await verifyPrivate(join(profile, directory), true);
          const result = await readdir(join(profile, directory));
          if (result.length > 4096) throw new Error("Legacy file count exceeds the import limit");
          return result;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
          throw error;
        }
      }
      for (const name of await names("control"))
        if (/^operation-[a-f0-9-]{36}\.json$/u.test(name)) files.push(`control/${name}`);
      for (const name of await names("")) {
        if (/^[a-z][a-z0-9-]*-hook-health\.json$/u.test(name)) files.push(name);
        if (/^foom-observers--?[0-9]+$/u.test(name))
          for (const file of await names(name))
            if (/^[a-z][a-z0-9-]*-health\.json$/u.test(file)) files.push(`${name}/${file}`);
      }
      return files.sort();
    },
    importControlRows,
    core,
  );
}
