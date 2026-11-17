import { eq, inArray, lte } from "drizzle-orm";
import { parseMessageBoard } from "../../control/message-board";
import { locationId } from "../../control/metadata";
import { identifier, object } from "../../../shared/control-validation";
import { record } from "../../../shared/remote-agent-protocol";
import type { MessageThread } from "../../../shared/message-board";
import type { DataTransaction } from "./commands";
import { RelationshipError } from "./commands";
import type { ProfileDatabase } from "./database";
import { LegacyBatch } from "./legacy-batch";
import * as tables from "./schema";

function thread(input: unknown): MessageThread {
  const parsed = parseMessageBoard({ version: 1, threads: [input], posts: [], receipts: [] })
    .threads[0];
  if (!parsed) throw new Error("Invalid thread");
  return parsed;
}
function saveThread(db: DataTransaction, value: MessageThread): void {
  db.insert(tables.boardThreads)
    .values({
      id: value.id,
      state: value.state,
      removedAt: value.child?.removedAt ?? null,
      data: JSON.stringify(value),
    })
    .run();
  for (const repository of value.to)
    db.insert(tables.boardRecipients)
      .values({ thread: value.id, repositorySnapshot: repository })
      .run();
  for (const repository of db.select().from(tables.repositories).all())
    if ([value.repository, ...value.to].includes(locationId(repository.path)))
      db.insert(tables.boardBindings)
        .values({ thread: value.id, repository: repository.path })
        .run();
}
function post(db: DataTransaction, input: unknown, requireOpen = false) {
  const id = identifier(object(input)["thread"]);
  const parent = db.select().from(tables.boardThreads).where(eq(tables.boardThreads.id, id)).get();
  if (!parent) throw new RelationshipError();
  const raw: unknown = JSON.parse(parent.data);
  const owner = thread(raw);
  if (requireOpen && owner.state === "resolved" && !owner.child)
    throw new Error("Thread is resolved");
  const parsed = parseMessageBoard({ version: 1, threads: [raw], posts: [input], receipts: [] })
    .posts[0];
  if (!parsed) throw new Error("Invalid post");
  return parsed;
}
function receipt(input: unknown) {
  const parsed = parseMessageBoard({ version: 1, threads: [], posts: [], receipts: [input] })
    .receipts[0];
  if (!parsed) throw new Error("Invalid receipt");
  return parsed;
}
export function saveDatabaseBoardThread(database: ProfileDatabase, input: unknown) {
  return database.write((db) => {
    saveThread(db, thread(input));
  });
}
export function appendDatabaseBoardPost(
  database: ProfileDatabase,
  input: unknown,
  received?: unknown,
) {
  return database.write((db) => {
    const value = post(db, input, true);
    db.insert(tables.boardPosts)
      .values({ id: value.id, thread: value.thread, kind: value.kind, data: JSON.stringify(value) })
      .run();
    const parent = db
      .select()
      .from(tables.boardThreads)
      .where(eq(tables.boardThreads.id, value.thread))
      .get();
    if (!parent) throw new RelationshipError();
    const owner = thread(JSON.parse(parent.data));
    const state = owner.child
      ? owner.state
      : value.author !== "human" &&
          (value.kind === "decision-needed" || owner.state === "waiting-human")
        ? "waiting-human"
        : value.author === "human" || value.kind === "request"
          ? "waiting-repo"
          : "open";
    db.update(tables.boardThreads)
      .set({ state, data: JSON.stringify({ ...owner, state, updatedAt: value.timestamp }) })
      .where(eq(tables.boardThreads.id, owner.id))
      .run();
    if (received !== undefined) {
      const receiptValue = receipt(received);
      if (receiptValue.result.thread !== value.thread || receiptValue.result.post !== value.id)
        throw new RelationshipError();
      db.insert(tables.boardReceipts)
        .values({
          scope: receiptValue.scope,
          key: receiptValue.key,
          hash: receiptValue.hash,
          thread: receiptValue.result.thread,
          post: receiptValue.result.post,
        })
        .run();
    }
  });
}
export function resolveDatabaseBoardThread(database: ProfileDatabase, id: string) {
  return database.write((db) => {
    const row = db
      .select()
      .from(tables.boardThreads)
      .where(eq(tables.boardThreads.id, identifier(id)))
      .get();
    if (!row) throw new RelationshipError();
    const value = thread(JSON.parse(row.data));
    db.update(tables.boardThreads)
      .set({
        state: "resolved",
        data: JSON.stringify({ ...value, state: "resolved", updatedAt: new Date().toISOString() }),
      })
      .where(eq(tables.boardThreads.id, id))
      .run();
  });
}
/** Caller is the main Board owner. No transport gains a post deletion capability. */
export function pruneBoardRows(db: DataTransaction, now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid retention time");
  const cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const expired = lte(tables.boardThreads.removedAt, cutoff);
  const ids = db.select({ id: tables.boardThreads.id }).from(tables.boardThreads).where(expired);
  db.delete(tables.boardReceipts).where(inArray(tables.boardReceipts.thread, ids)).run();
  db.delete(tables.boardPosts).where(inArray(tables.boardPosts.thread, ids)).run();
  db.delete(tables.boardRecipients).where(inArray(tables.boardRecipients.thread, ids)).run();
  db.delete(tables.boardBindings).where(inArray(tables.boardBindings.thread, ids)).run();
  return Number(db.delete(tables.boardThreads).where(expired).run().changes);
}
export function pruneDatabaseBoard(database: ProfileDatabase, now: number) {
  return database.write((db) => pruneBoardRows(db, now));
}
export function importBoardRows(db: DataTransaction, text: string | null | undefined) {
  const batch = new LegacyBatch(db);
  if (text == null) return batch.report();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    batch.reject("control/board.json", -1);
    return batch.report();
  }
  if (!record(data) || data["version"] !== 1) throw new Error("Unsupported legacy board version");
  for (const name of ["threads", "posts", "receipts"] as const) {
    const rows = data[name];
    if (!Array.isArray(rows) || rows.length > 65536) {
      batch.reject(`control/board.json#${name}`, -1);
      continue;
    }
    for (const [position, input] of rows.entries()) {
      const source = `control/board.json#${name}`;
      if (name === "threads")
        batch.row(
          source,
          position,
          () => thread(input),
          (value) => {
            saveThread(db, value);
          },
        );
      else if (name === "posts")
        batch.row(
          source,
          position,
          () => post(db, input),
          (value) => {
            db.insert(tables.boardPosts)
              .values({
                id: value.id,
                thread: value.thread,
                kind: value.kind,
                data: JSON.stringify(value),
              })
              .run();
          },
        );
      else
        batch.row(
          source,
          position,
          () => receipt(input),
          (value) => {
            db.insert(tables.boardReceipts)
              .values({
                scope: value.scope,
                key: value.key,
                hash: value.hash,
                thread: value.result.thread,
                post: value.result.post,
              })
              .run();
          },
        );
    }
  }
  return batch.report();
}
