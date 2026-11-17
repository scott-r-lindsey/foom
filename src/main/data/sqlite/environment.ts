import { and, eq } from "drizzle-orm";
import { parseEnvironmentChange } from "../../setup/environment";
import type { SecretCipher } from "../../setup/environment";
import {
  environmentProblem,
  nameProblem,
  foldName,
  hasUrlCredentials,
  ENVIRONMENT_ROW_LIMIT,
} from "../../../shared/environment-rules";
import { validAgentId } from "../../../shared/providers/catalog";
import { record } from "../../../shared/remote-agent-protocol";
import type { EnvironmentState } from "../../../shared/environment";
import { importLegacyGroup } from "./importer";
import type { ProfileDatabase } from "./database";
import type { DataTransaction } from "./commands";
import * as tables from "./schema";

class KeychainUnavailable extends Error {
  constructor() {
    super("Environment secrets require the system keychain");
  }
}
function unlock(cipher: SecretCipher): void {
  if (!cipher.supported() || !cipher.available()) throw new KeychainUnavailable();
}
function scope(value: string): void {
  if (value !== "all" && !validAgentId(value)) throw new Error("Invalid environment scope");
}
function validate(name: string, value: string, windows: boolean): void {
  if (environmentProblem(name, value, windows)) throw new Error("Invalid environment value");
}

/** Main-only command. Callers supply the existing safeStorageCipher capability. */
export function saveDatabaseEnvironment(
  database: ProfileDatabase,
  cipher: SecretCipher,
  input: unknown,
  windows = process.platform === "win32",
) {
  return database.write((db) => {
    const change = parseEnvironmentChange(input);
    scope(change.scope);
    const previous =
      change.previous === null
        ? undefined
        : db
            .select()
            .from(tables.environmentEntries)
            .where(
              and(
                eq(tables.environmentEntries.scope, change.scope),
                eq(tables.environmentEntries.fold, foldName(change.previous, windows)),
              ),
            )
            .get();
    if (change.previous !== null && !previous) throw new Error("Environment row no longer exists");
    const folded = foldName(change.name, windows);
    const existing = db
      .select()
      .from(tables.environmentEntries)
      .where(eq(tables.environmentEntries.scope, change.scope))
      .all();
    if (existing.some((row) => row.fold === folded && row.fold !== previous?.fold))
      throw new Error("Duplicate environment name");
    if (!previous && existing.length >= ENVIRONMENT_ROW_LIMIT)
      throw new Error("Environment capacity reached");
    const scopes = db.select().from(tables.environmentScopes).all();
    if (!scopes.some((row) => row.scope === change.scope) && scopes.length >= 100)
      throw new Error("Environment capacity reached");
    let value = change.value;
    let encrypted: Buffer | null = null;
    if (value === null) {
      if (!previous || previous.secret !== 1 || !previous.cipher || !change.secret)
        throw new Error("Invalid retained secret");
      encrypted = Buffer.from(previous.cipher);
      if (change.name !== previous.name) {
        unlock(cipher);
        validate(change.name, cipher.decrypt(encrypted), windows);
      }
    } else {
      validate(change.name, value, windows);
      if (change.secret || hasUrlCredentials(value)) {
        unlock(cipher);
        encrypted = cipher.encrypt(value);
        value = null;
      }
    }
    db.insert(tables.environmentScopes).values({ scope: change.scope }).onConflictDoNothing().run();
    if (previous)
      db.delete(tables.environmentEntries)
        .where(
          and(
            eq(tables.environmentEntries.scope, previous.scope),
            eq(tables.environmentEntries.fold, previous.fold),
          ),
        )
        .run();
    db.insert(tables.environmentEntries)
      .values({
        scope: change.scope,
        fold: folded,
        name: change.name,
        secret: Number(encrypted !== null),
        value,
        cipher: encrypted,
      })
      .run();
  });
}
export function removeDatabaseEnvironmentScope(database: ProfileDatabase, name: string) {
  return database.write((db) => {
    scope(name);
    db.delete(tables.environmentEntries).where(eq(tables.environmentEntries.scope, name)).run();
    db.delete(tables.environmentScopes).where(eq(tables.environmentScopes.scope, name)).run();
  });
}
export function removeDatabaseEnvironment(
  database: ProfileDatabase,
  id: string,
  name: string,
  windows = process.platform === "win32",
) {
  return database.write((db) => {
    scope(id);
    if (nameProblem(name)) throw new Error("Invalid environment name");
    db.delete(tables.environmentEntries)
      .where(
        and(
          eq(tables.environmentEntries.scope, id),
          eq(tables.environmentEntries.fold, foldName(name, windows)),
        ),
      )
      .run();
  });
}
export function readDatabaseEnvironment(
  database: ProfileDatabase,
  cipher: SecretCipher,
  windows = process.platform === "win32",
): Promise<EnvironmentState> {
  return database.read((db) => {
    const lists: Record<string, { name: string; value: string | null; secret: boolean }[]> & {
      all: { name: string; value: string | null; secret: boolean }[];
    } = { all: [] };
    for (const entry of db.select().from(tables.environmentScopes).all()) lists[entry.scope] = [];
    for (const row of db.select().from(tables.environmentEntries).all())
      (lists[row.scope] ??= []).push({
        name: row.name,
        value: row.secret === 1 ? null : row.value,
        secret: row.secret === 1,
      });
    return { lists, windows, secrets: cipher.supported() };
  });
}
export function importEnvironmentRows(
  db: DataTransaction,
  text: string | null | undefined,
  cipher: SecretCipher,
  windows: boolean,
) {
  let accepted = 0;
  let quarantined = 0;
  let available: boolean | undefined;
  const reject = (position: number, reason: "invalid" | "conflict" = "invalid") => {
    db.insert(tables.quarantine)
      .values({ source: "environment.json#lists", position, reason })
      .run();
    quarantined++;
  };
  if (text == null) return { accepted, quarantined };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    reject(-1);
    return { accepted, quarantined };
  }
  if (!record(data) || data["version"] !== 1)
    throw new Error("Unsupported legacy environment version");
  const lists = data["lists"];
  if (!record(lists) || Object.keys(lists).length > 100) {
    reject(-1);
    return { accepted, quarantined };
  }
  let position = 0;
  for (const [id, input] of Object.entries(lists)) {
    if (
      (id !== "all" && !validAgentId(id)) ||
      !Array.isArray(input) ||
      input.length > ENVIRONMENT_ROW_LIMIT
    ) {
      reject(position++);
      continue;
    }
    db.insert(tables.environmentScopes).values({ scope: id }).onConflictDoNothing().run();
    for (const raw of input) {
      const index = position++;
      let row: typeof tables.environmentEntries.$inferInsert;
      try {
        if (
          !record(raw) ||
          typeof raw["name"] !== "string" ||
          (raw["secret"] !== undefined && typeof raw["secret"] !== "boolean")
        )
          throw new Error("Invalid row");
        const secret = raw["secret"] === true;
        let value: string | null = null;
        let encrypted: Buffer | null = null;
        if (secret) {
          if (
            Object.keys(raw).some((key) => !["name", "secret", "cipher"].includes(key)) ||
            typeof raw["cipher"] !== "string" ||
            raw["cipher"].length > 24000
          )
            throw new Error("Invalid ciphertext");
          encrypted = Buffer.from(raw["cipher"], "base64");
          if (
            !encrypted.length ||
            encrypted.length > 16384 ||
            encrypted.toString("base64") !== raw["cipher"]
          )
            throw new Error("Invalid ciphertext");
          if (available === undefined) {
            available = cipher.supported() && cipher.available();
          }
          if (!available) throw new KeychainUnavailable();
          validate(raw["name"], cipher.decrypt(encrypted), windows);
        } else {
          if (
            Object.keys(raw).some((key) => !["name", "secret", "value"].includes(key)) ||
            typeof raw["value"] !== "string" ||
            hasUrlCredentials(raw["value"])
          )
            throw new Error("Invalid plain row");
          value = raw["value"];
          validate(raw["name"], value, windows);
        }
        row = {
          scope: id,
          fold: foldName(raw["name"], windows),
          name: raw["name"],
          secret: Number(secret),
          value,
          cipher: encrypted,
        };
      } catch (error) {
        if (error instanceof KeychainUnavailable) throw error;
        reject(index);
        continue;
      }
      if (
        db
          .select()
          .from(tables.environmentEntries)
          .where(
            and(
              eq(tables.environmentEntries.scope, id),
              eq(tables.environmentEntries.fold, row.fold),
            ),
          )
          .get()
      ) {
        reject(index, "conflict");
        continue;
      }
      db.insert(tables.environmentEntries).values(row).run();
      accepted++;
    }
  }
  return { accepted, quarantined };
}
export function importDatabaseEnvironment(
  database: ProfileDatabase,
  profile: string,
  cipher: SecretCipher,
  windows = process.platform === "win32",
) {
  return importLegacyGroup(database, profile, "environment-v1", ["environment.json"], (db, input) =>
    importEnvironmentRows(db, input["environment.json"], cipher, windows),
  );
}
