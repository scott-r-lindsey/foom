import { eq, notInArray, sql } from "drizzle-orm";
import { readdir } from "node:fs/promises";
import { parsePlacements } from "../window/window-placement";
import { parseRegistry } from "../previews/registry";
import { object } from "../../shared/control-validation";
import { importLegacyGroup } from "./importer";
import type { LegacyOriginals } from "./importer";
import type { ProfileDatabase } from "../data/sqlite/database";
import type { DataTransaction } from "./commands";
import { LegacyBatch } from "./legacy-batch";
import * as tables from "../data/sqlite/schema";

function placement(input: unknown) {
  const result = parsePlacements([input])[0];
  if (!result) throw new Error("Invalid window placement");
  return { id: result.id, display: result.display, ...result.bounds, maximized: result.maximized };
}
function size(input: unknown) {
  const value = object(input);
  const width = value["width"];
  const height = value["height"];
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("Invalid window size");
  return { id: 1, width, height };
}
function periodDate(period: string, input: unknown) {
  if (
    !["d", "w", "m"].includes(period) ||
    typeof input !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(input) ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString().slice(0, 10) !== input ||
    (period === "w" && new Date(input).getUTCDay() !== 1) ||
    (period === "m" && !input.endsWith("-01"))
  )
    throw new Error("Invalid update activity");
  return { period, date: input };
}
function preview(db: DataTransaction, window: string, input: unknown) {
  if (!/^[a-zA-Z0-9-]{1,64}$/u.test(window)) throw new Error("Invalid preview owner");
  const value = parseRegistry([input])[0];
  if (!value) throw new Error("Invalid preview metadata");
  const managed = db
    .select()
    .from(tables.worktrees)
    .where(eq(tables.worktrees.path, value.worktree))
    .get();
  return {
    id: value.id,
    window,
    worktree: managed?.path ?? null,
    worktreeSnapshot: value.worktree,
    relativePath: value.relativePath,
    network: false,
  };
}
/** Main-only geometry. Existing native placement/clamping remains required. */
export function saveDatabaseWindows(database: ProfileDatabase, input: unknown) {
  if (!Array.isArray(input) || input.length > 32) throw new Error("Invalid window set");
  const rows = input.map(placement);
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("Duplicate window");
  return database.write((db) => {
    const ids = rows.map((row) => row.id);
    if (ids.length) {
      db.delete(tables.previewRecords).where(notInArray(tables.previewRecords.window, ids)).run();
      db.delete(tables.windows).where(notInArray(tables.windows.id, ids)).run();
    } else {
      db.delete(tables.previewRecords).run();
      db.delete(tables.windows).run();
    }
    for (const row of rows)
      db.insert(tables.windows)
        .values(row)
        .onConflictDoUpdate({ target: tables.windows.id, set: row })
        .run();
  });
}
export function saveDatabaseWindowSize(database: ProfileDatabase, input: unknown) {
  const row = size(input);
  return database.write((db) => {
    db.insert(tables.legacyWindowSize)
      .values(row)
      .onConflictDoUpdate({ target: tables.legacyWindowSize.id, set: row })
      .run();
  });
}
/** Reserve monotonically before the existing owner's network request. No request is sent here. */
export function reserveDatabaseUpdateActivity(database: ProfileDatabase, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const monday = new Date(`${day}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const values = { d: day, w: monday.toISOString().slice(0, 10), m: day.slice(0, 8) + "01" };
  return database.write((db) => {
    const flags = new URLSearchParams();
    for (const [period, date] of Object.entries(values)) {
      const row = periodDate(period, date);
      const previous = db
        .select()
        .from(tables.updateActivity)
        .where(eq(tables.updateActivity.period, period))
        .get();
      if (!previous || date > previous.date) {
        db.insert(tables.updateActivity)
          .values(row)
          .onConflictDoUpdate({ target: tables.updateActivity.period, set: row })
          .run();
        flags.set(period, "1");
      }
    }
    return flags.size ? `?${flags.toString()}` : "";
  });
}
/** Metadata grants no file capability; PreviewHost still revalidates Git/contained file identity. */
export function saveDatabasePreview(database: ProfileDatabase, window: string, input: unknown) {
  return database.write((db) => {
    const row = preview(db, window, input);
    const count =
      db
        .select({ count: sql<number>`count(*)` })
        .from(tables.previewRecords)
        .where(eq(tables.previewRecords.window, window))
        .get()?.count ?? 0;
    const old = db
      .select()
      .from(tables.previewRecords)
      .where(eq(tables.previewRecords.id, row.id))
      .get();
    if (count >= 256 && old?.window !== window) throw new Error("Preview capacity reached");
    db.insert(tables.previewRecords)
      .values(row)
      .onConflictDoUpdate({ target: tables.previewRecords.id, set: row })
      .run();
  });
}
export function forgetDatabasePreview(database: ProfileDatabase, window: string, id: string) {
  return database.write((db) => {
    const row = db
      .select()
      .from(tables.previewRecords)
      .where(eq(tables.previewRecords.id, id))
      .get();
    if (row && row.window !== window) throw new Error("Preview owner mismatch");
    db.delete(tables.previewRecords).where(eq(tables.previewRecords.id, id)).run();
  });
}

export function importWindowRows(db: DataTransaction, input: LegacyOriginals) {
  const batch = new LegacyBatch(db);
  function parse(name: string) {
    const value = input[name];
    if (value === null || value === undefined) return undefined;
    try {
      const result: unknown = JSON.parse(value);
      return result;
    } catch {
      batch.reject(name, -1);
      return undefined;
    }
  }
  const placements = parse("windows.json");
  if (placements !== undefined) {
    if (!Array.isArray(placements) || placements.length > 32) batch.reject("windows.json", -1);
    else
      for (const [position, value] of placements.entries())
        batch.row(
          "windows.json",
          position,
          () => placement(value),
          (row) => {
            db.insert(tables.windows).values(row).run();
          },
        );
  }
  const legacy = parse("window-size.json");
  if (legacy !== undefined)
    batch.row(
      "window-size.json",
      0,
      () => size(legacy),
      (row) => {
        db.insert(tables.legacyWindowSize).values(row).run();
      },
    );
  const activity = parse("update-activity.json");
  if (activity !== undefined) {
    let entries: [string, unknown][] = [];
    try {
      entries = Object.entries(object(activity));
    } catch {
      batch.reject("update-activity.json", -1);
    }
    for (const [position, [key, value]] of entries.entries())
      batch.row(
        "update-activity.json",
        position,
        () => periodDate(key, value),
        (row) => {
          db.insert(tables.updateActivity).values(row).run();
        },
      );
  }
  for (const name of Object.keys(input)) {
    const match = /^previews-([a-zA-Z0-9-]{1,64})\.json$/u.exec(name);
    const window = match?.[1];
    if (!window) continue;
    const values = parse(name);
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length > 256) {
      batch.reject(name, -1);
      continue;
    }
    for (const [position, value] of values.entries())
      batch.row(
        name,
        position,
        () => preview(db, window, value),
        (row) => {
          db.insert(tables.previewRecords).values(row).run();
        },
      );
  }
  return batch.report();
}
export function importDatabaseWindows(database: ProfileDatabase, profile: string) {
  const core = ["windows.json", "window-size.json", "update-activity.json"];
  return importLegacyGroup(
    database,
    profile,
    "window-state-v1",
    async () => {
      const names = await readdir(profile);
      if (names.length > 4096) throw new Error("Legacy file count exceeds the import limit");
      return [
        ...core,
        ...names.filter((name) => /^previews-[a-zA-Z0-9-]{1,64}\.json$/u.test(name)),
      ].sort();
    },
    importWindowRows,
    core,
  );
}
