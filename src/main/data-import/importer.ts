import { safeStorageCipher } from "../setup/environment";
import type { SecretCipher } from "../../shared/secret-cipher";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  createPrivateFile,
  privateDirectory,
  verifyLegacyProfileFile,
  verifyPrivate,
} from "../../node-common/private-files";
import { registeredHosts } from "../../shared/registered-hosts";
import { record } from "../../shared/remote-agent-protocol";
import { readSessions } from "../workspace/session-store";
import { insertSession, savedPath, worktreeClaim, RelationshipError } from "./commands";
import type { RegisteredHost } from "../../shared/registered-hosts.d";
import type { DataTransaction } from "./commands";
import type { ProfileDatabase } from "../data/sqlite/database";
import * as tables from "../data/sqlite/schema";

const sources = ["settings.json", "worktrees.json", "sessions.json"] as const;
type Source = (typeof sources)[number];
export type LegacyOriginals = Readonly<Record<string, string | null>>;
type Originals = LegacyOriginals;
export interface ImportReport {
  accepted: number;
  quarantined: number;
  sources: Source[];
}
const importName = "hosts-worktrees-sessions-v1";

async function readSource(profile: string, source: string): Promise<string | null> {
  const path = join(profile, source);
  try {
    let parent = profile;
    for (const component of source.split("/").slice(0, -1)) {
      parent = join(parent, component);
      await verifyPrivate(parent, true);
    }
    await verifyLegacyProfileFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const file = await open(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const info = await file.stat();
    const limit = /^control\/operation-[a-f0-9-]{36}\.json$/u.test(source)
      ? 16384
      : 32 * 1024 * 1024;
    if (!info.isFile() || info.size > limit)
      throw new Error("Legacy data file exceeds the import limit");
    const bytes = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > limit) throw new Error("Legacy data file exceeds the import limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}
/** Recovery snapshot is published atomically before the SQL transaction. A crash
 * leaves either no snapshot or the complete immutable input for the next attempt.
 * Production JSON files remain writable by their existing owners in phase C.
 */
async function originals(
  profile: string,
  name: string,
  files: readonly string[] | (() => Promise<readonly string[]>),
  cipher: SecretCipher,
  required?: readonly string[],
): Promise<Originals> {
  if (!/^[a-z0-9-]+$/u.test(name)) throw new Error("Invalid legacy source");
  const validSource = (file: string) =>
    /^[a-zA-Z0-9_./-]+$/u.test(file) &&
    !file.split("/").some((part) => !part || part === "." || part === "..");
  const unlock = () => {
    if (!cipher.supported() || !cipher.available())
      throw new Error("Recovery snapshots require the system keychain");
  };
  const directory = await privateDirectory(await privateDirectory(profile, "data"), "recovery");
  const file = join(directory, `${name}.json`);
  let found = false;
  try {
    const info = await lstat(file);
    found = true;
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > 1024 * 1024 * 1024 ||
      (process.platform !== "win32" &&
        (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o400))
    )
      throw new Error("Invalid recovery snapshot permissions or size");
    const envelope: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      !record(envelope) ||
      envelope["version"] !== 1 ||
      Object.keys(envelope).length !== 2 ||
      typeof envelope["cipher"] !== "string"
    )
      throw new Error("Invalid recovery snapshot; restore the original files");
    const encrypted = Buffer.from(envelope["cipher"], "base64");
    if (!encrypted.length || encrypted.toString("base64") !== envelope["cipher"])
      throw new Error("Invalid recovery snapshot ciphertext");
    unlock();
    const value: unknown = JSON.parse(cipher.decrypt(encrypted));
    if (
      !record(value) ||
      (required === undefined &&
        typeof files !== "function" &&
        Object.keys(value).length !== files.length) ||
      !(required ?? (typeof files === "function" ? [] : files)).every((file) =>
        Object.hasOwn(value, file),
      ) ||
      !Object.entries(value).every(
        ([file, text]) => validSource(file) && (text === null || typeof text === "string"),
      )
    )
      throw new Error("Invalid recovery snapshot; restore the original files");
    const result: Record<string, string | null> = {};
    for (const file of Object.keys(value)) {
      const text = value[file];
      if (text === null || typeof text === "string") result[file] = text;
    }
    return result;
  } catch (error) {
    if (found || !(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  unlock();
  const paths = typeof files === "function" ? await files() : files;
  if (paths.some((file) => !validSource(file))) throw new Error("Invalid legacy source");
  const contents: Record<string, string | null> = {};
  let total = 0;
  for (const file of paths) {
    const text = await readSource(profile, file);
    total += Buffer.byteLength(text ?? "");
    if (total > 256 * 1024 * 1024) throw new Error("Legacy group exceeds the import limit");
    contents[file] = text;
  }
  // Encryption must succeed before creating any recovery file. Never fall back
  // to plaintext, even for groups whose known fields contain no secrets.
  const encrypted = cipher.encrypt(JSON.stringify(contents));
  const temporary = join(directory, `${randomUUID()}.tmp`);
  const handle = await createPrivateFile(temporary);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, cipher: encrypted.toString("base64") }));
    await handle.sync();
    await chmod(temporary, 0o400);
    await handle.close();
    await rename(temporary, file);
    if (process.platform !== "win32") {
      const parent = await open(directory, constants.O_RDONLY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
  return contents;
}

/** Runs only inside ProfileDatabase.write; exported for crash/rollback tests.
 * Quarantine stores fixed reasons and recovery positions, never rejected payloads.
 */
export function importRows(db: DataTransaction, input: Originals): ImportReport {
  const report: ImportReport = {
    accepted: 0,
    quarantined: 0,
    sources: sources.filter((source) => input[source] != null),
  };
  const quarantine = (
    source: string,
    position: number,
    reason: "invalid" | "relationship" | "conflict",
  ) => {
    db.insert(tables.quarantine).values({ source, position, reason }).run();
    report.quarantined++;
  };
  function accept(source: string, position: number, action: () => void): boolean {
    db.run(sql`SAVEPOINT import_row`);
    try {
      action();
      db.run(sql`RELEASE import_row`);
      report.accepted++;
      return true;
    } catch (error) {
      db.run(sql`ROLLBACK TO import_row`);
      db.run(sql`RELEASE import_row`);
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      if (cause instanceof RelationshipError) quarantine(source, position, "relationship");
      else if (
        cause instanceof Error &&
        "errcode" in cause &&
        typeof cause.errcode === "number" &&
        (cause.errcode & 255) === 19
      )
        quarantine(source, position, cause.errcode === 787 ? "relationship" : "conflict");
      else throw error;
      return false;
    }
  }
  function parse(source: Source): unknown {
    const text = input[source] ?? null;
    if (text === null) return undefined;
    try {
      const result: unknown = JSON.parse(text);
      return result;
    } catch {
      quarantine(source, -1, "invalid");
      return undefined;
    }
  }
  const settings = parse("settings.json");
  if (settings !== undefined) {
    if (!record(settings) || (settings["version"] !== 1 && settings["version"] !== 2))
      throw new Error("Unsupported legacy settings version; use a compatible importer");
    const body = settings["settings"];
    const hosts = record(body) ? body["registeredHosts"] : undefined;
    if (hosts !== undefined) {
      if (!Array.isArray(hosts) || hosts.length > 32) quarantine("settings.json", -1, "invalid");
      else {
        const accepted: RegisteredHost[] = [];
        for (const [position, host] of hosts.entries()) {
          const candidate: unknown = host;
          const list = [candidate];
          if (!registeredHosts(list) || !registeredHosts([...accepted, ...list])) {
            quarantine("settings.json#settings.registeredHosts", position, "invalid");
            continue;
          }
          const validated = list[0];
          if (!validated) throw new Error("Invalid host");
          if (
            accept("settings.json#settings.registeredHosts", position, () =>
              db
                .insert(tables.hosts)
                .values({ alias: validated.host, data: JSON.stringify(validated) })
                .run(),
            )
          )
            accepted.push(validated);
        }
      }
    } else if (!record(body)) quarantine("settings.json", -1, "invalid");
  }
  const worktrees = parse("worktrees.json");
  if (worktrees !== undefined) {
    if (!record(worktrees) || worktrees["version"] !== 1)
      throw new Error("Unsupported legacy worktree version; use a compatible importer");
    const repositories = worktrees["repositories"];
    const registrations = worktrees["registrations"];
    if (!Array.isArray(repositories) || repositories.length > 10000)
      quarantine("worktrees.json", -1, "invalid");
    else
      for (const [position, path] of repositories.entries()) {
        if (!savedPath(path)) {
          quarantine("worktrees.json#repositories", position, "invalid");
          continue;
        }
        accept("worktrees.json#repositories", position, () =>
          db.insert(tables.repositories).values({ path }).run(),
        );
      }
    if (registrations !== undefined) {
      if (!Array.isArray(registrations) || registrations.length > 10000)
        quarantine("worktrees.json", -1, "invalid");
      else
        for (const [position, row] of registrations.entries()) {
          if (
            !record(row) ||
            !savedPath(row["path"]) ||
            typeof row["id"] !== "string" ||
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(row["id"])
          ) {
            quarantine("worktrees.json#registrations", position, "invalid");
            continue;
          }
          const path = row["path"];
          const registration = row["id"];
          accept("worktrees.json#registrations", position, () => {
            if (
              !db.select().from(tables.repositories).where(eq(tables.repositories.path, path)).get()
            )
              throw new RelationshipError();
            db.update(tables.repositories)
              .set({ registration })
              .where(eq(tables.repositories.path, path))
              .run();
          });
        }
    }
    for (const key of ["managed", "pendingRemovals", "parents"] as const) {
      const rows = worktrees[key];
      if (rows === undefined && key !== "managed") continue;
      if (!Array.isArray(rows) || rows.length > 10000) {
        quarantine("worktrees.json", -1, "invalid");
        continue;
      }
      for (const [position, row] of rows.entries()) {
        if (key === "managed" && worktreeClaim(row))
          accept(`worktrees.json#${key}`, position, () =>
            db
              .insert(tables.worktrees)
              .values({ path: row.path, repository: row.repository, data: JSON.stringify(row) })
              .run(),
          );
        else if (
          key === "pendingRemovals" &&
          record(row) &&
          savedPath(row["path"]) &&
          savedPath(row["repository"]) &&
          savedPath(row["root"]) &&
          typeof row["directoryIdentity"] === "string"
        ) {
          const path = row["path"];
          const repository = row["repository"];
          accept(`worktrees.json#${key}`, position, () =>
            db
              .insert(tables.pendingRemovals)
              .values({
                path,
                repository,
                data: JSON.stringify({
                  path,
                  repository,
                  root: row["root"],
                  directoryIdentity: row["directoryIdentity"],
                }),
              })
              .run(),
          );
        } else if (
          key === "parents" &&
          record(row) &&
          savedPath(row["path"]) &&
          typeof row["identity"] === "string"
        ) {
          const path = row["path"];
          const identity = row["identity"];
          accept(`worktrees.json#${key}`, position, () =>
            db.insert(tables.worktreeParents).values({ path, identity }).run(),
          );
        } else quarantine(`worktrees.json#${key}`, position, "invalid");
      }
    }
  }
  const sessions = parse("sessions.json");
  if (sessions !== undefined) {
    if (!Array.isArray(sessions) || sessions.length > 1000)
      quarantine("sessions.json", -1, "invalid");
    else {
      const pending = new Map<number, ReturnType<typeof readSessions>[number]>();
      for (const [position, row] of sessions.entries()) {
        try {
          const session = readSessions([row])[0];
          if (!session) throw new Error("Invalid session");
          pending.set(position, session);
        } catch {
          quarantine("sessions.json", position, "invalid");
        }
      }
      // Topological import: rejected/missing parents never fabricate authority.
      while (pending.size) {
        let progress = false;
        for (const [position, session] of pending) {
          if (
            session.parentId &&
            !db.select().from(tables.sessions).where(eq(tables.sessions.id, session.parentId)).get()
          )
            continue;
          accept("sessions.json", position, () => {
            insertSession(db, session);
          });
          pending.delete(position);
          progress = true;
        }
        if (!progress) {
          for (const position of pending.keys())
            quarantine("sessions.json", position, "relationship");
          break;
        }
      }
    }
  }
  return report;
}

/** Explicit opt-in preparation only; never called from production startup in C. */
const importing = new WeakMap<ProfileDatabase, Promise<unknown>>();
export function importLegacy(database: ProfileDatabase, profile: string) {
  return importLegacyGroup(database, profile, importName, sources, importRows);
}
export function importLegacyGroup(
  database: ProfileDatabase,
  profile: string,
  name: string,
  files: readonly string[] | (() => Promise<readonly string[]>),
  ingest: (db: DataTransaction, input: LegacyOriginals) => unknown,
  required?: readonly string[],
) {
  const next = (importing.get(database) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const previous = await database.read((db) =>
        db.select().from(tables.imports).where(eq(tables.imports.name, name)).get(),
      );
      if (previous) {
        let publicationPending = false;
        try {
          await database.retryPublication();
        } catch {
          publicationPending = true;
        }
        return { value: { alreadyImported: true, report: previous.report }, publicationPending };
      }
      const cipher =
        database.recoveryCipher ?? safeStorageCipher((await import("electron")).safeStorage);
      const snapshot = await originals(profile, name, files, cipher, required);
      return database.write((db) => {
        const previous = db
          .select()
          .from(tables.imports)
          .where(eq(tables.imports.name, name))
          .get();
        if (previous) return { alreadyImported: true, report: previous.report };
        const report = JSON.stringify(ingest(db, snapshot));
        db.insert(tables.imports).values({ name, report }).run();
        return { alreadyImported: false, report };
      });
    });
  importing.set(database, next);
  return next;
}
