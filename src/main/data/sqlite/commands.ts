import { and, eq, inArray } from "drizzle-orm";
import { forgeBranch } from "../../control/forge";
import type { ReviewCheckout } from "../../workspace/review-worktrees";
import { isAbsolute } from "node:path";
import { registeredHosts, hostAlias } from "../../../shared/registered-hosts";
import { readSessions } from "../../workspace/session-store";
import { record } from "../../../shared/remote-agent-protocol";
import type { RegisteredHost } from "../../../shared/registered-hosts.d";
import type { StoredSession } from "../../workspace/session-restore.d";
import type { ProfileDatabase } from "./database";
import * as tables from "./schema";

export type DataTransaction = Parameters<Parameters<ProfileDatabase["write"]>[0]>[0];
export type DataCommand =
  | { type: "register-host"; host: RegisteredHost }
  | { type: "register-repository"; path: string; registration?: string }
  | {
      type: "remember-worktree";
      worktree: {
        path: string;
        repository: string;
        root: string;
        identity: string;
        directoryIdentity?: string;
        review?: ReviewCheckout;
      };
    }
  | { type: "save-session"; session: StoredSession }
  | { type: "forget-host"; host: string }
  | { type: "remove-session"; id: string };

export function savedPath(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 4096 && isAbsolute(value) && !value.includes("\0")
  );
}
function bounded(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
export function worktreeClaim(
  value: unknown,
): value is Extract<DataCommand, { type: "remember-worktree" }>["worktree"] {
  return (
    record(value) &&
    Object.keys(value).every((key) =>
      ["path", "repository", "root", "identity", "directoryIdentity", "review"].includes(key),
    ) &&
    savedPath(value["path"]) &&
    savedPath(value["repository"]) &&
    savedPath(value["root"]) &&
    bounded(value["identity"]) &&
    (value["directoryIdentity"] === undefined || bounded(value["directoryIdentity"])) &&
    (value["review"] === undefined || reviewClaim(value["review"]))
  );
}
export class RelationshipError extends Error {
  constructor() {
    super("Invalid saved relationship");
  }
}
export function insertSession(db: DataTransaction, input: unknown): void {
  const session = readSessions([input])[0];
  if (!session) throw new Error("Invalid session");
  const kind = session.remote
    ? "remote"
    : session.home
      ? "home"
      : session.config
        ? "config"
        : "local";
  const host = session.placement?.kind === "remote" ? session.placement.host : null;
  if (session.remote && !host) throw new RelationshipError();
  const repository = kind === "local" ? session.repository : null;
  const managed =
    kind === "local"
      ? db.select().from(tables.worktrees).where(eq(tables.worktrees.path, session.worktree)).get()
      : undefined;
  if (managed && managed.repository !== repository) throw new RelationshipError();
  if (session.parentId) {
    const parent = db
      .select()
      .from(tables.sessions)
      .where(eq(tables.sessions.id, session.parentId))
      .get();
    if (!parent || parent.host !== host || parent.repository !== repository)
      throw new RelationshipError();
  }
  // All retained metadata passed the existing restoration validator. It remains a
  // saved claim; database rows never bypass live identity/authority revalidation.
  db.insert(tables.sessions)
    .values({
      id: session.id,
      host,
      repository,
      worktree: managed?.path ?? null,
      parent: session.parentId ?? null,
      kind,
      data: JSON.stringify(session),
    })
    .run();
  for (const owned of session.orchestrator?.worktrees ?? []) {
    const tree = db
      .select()
      .from(tables.worktrees)
      .where(eq(tables.worktrees.path, owned.path))
      .get();
    if (!tree || tree.repository !== repository || !sameIdentity(tree.data, owned.identity))
      throw new RelationshipError();
    db.insert(tables.ownedWorktrees)
      .values({
        path: owned.path,
        owner: session.id,
        state: owned.state,
        data: JSON.stringify(owned),
      })
      .run();
  }
}

/** Deletes saved metadata only. No SSH, Git, daemon stop/kill or filesystem effects. */
function removeSessions(db: DataTransaction, ids: string[]): void {
  if (!ids.length) return;
  db.delete(tables.ownedWorktrees).where(inArray(tables.ownedWorktrees.owner, ids)).run();
  // Children outside the intended set must reject the operation, not disappear.
  db.update(tables.sessions)
    .set({ parent: null })
    .where(and(inArray(tables.sessions.id, ids), inArray(tables.sessions.parent, ids)))
    .run();
  db.delete(tables.sessions).where(inArray(tables.sessions.id, ids)).run();
}
export function executeDataCommand(database: ProfileDatabase, command: DataCommand) {
  return database.write((db) => {
    switch (command.type) {
      case "register-host":
        if (!registeredHosts([command.host])) throw new Error("Invalid registered host");
        db.insert(tables.hosts)
          .values({ alias: command.host.host, data: JSON.stringify(command.host) })
          .run();
        break;
      case "register-repository":
        if (
          !savedPath(command.path) ||
          (command.registration !== undefined &&
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(command.registration))
        )
          throw new Error("Invalid repository");
        db.insert(tables.repositories)
          .values({ path: command.path, registration: command.registration ?? null })
          .run();
        break;
      case "remember-worktree":
        if (!worktreeClaim(command.worktree)) throw new Error("Invalid worktree");
        db.insert(tables.worktrees)
          .values({
            path: command.worktree.path,
            repository: command.worktree.repository,
            data: JSON.stringify(command.worktree),
          })
          .run();
        break;
      case "save-session":
        insertSession(db, command.session);
        break;
      case "forget-host": {
        if (!hostAlias(command.host)) throw new Error("Invalid host alias");
        db.delete(tables.forgeObservations)
          .where(eq(tables.forgeObservations.host, command.host))
          .run();
        db.delete(tables.repositoryObservations)
          .where(eq(tables.repositoryObservations.host, command.host))
          .run();
        const ids = db
          .select({ id: tables.sessions.id })
          .from(tables.sessions)
          .where(eq(tables.sessions.host, command.host))
          .all()
          .map((row) => row.id);
        removeSessions(db, ids);
        db.delete(tables.hosts).where(eq(tables.hosts.alias, command.host)).run();
        break;
      }
      case "remove-session":
        if (!bounded(command.id)) throw new Error("Invalid session id");
        removeSessions(db, [command.id]);
        break;
      default:
        throw new Error("Unknown data command");
    }
  });
}

function sameIdentity(data: string, identity: string): boolean {
  const value: unknown = JSON.parse(data);
  return record(value) && value["identity"] === identity;
}

function reviewClaim(value: unknown): value is ReviewCheckout {
  return (
    record(value) &&
    Object.keys(value).every((key) => ["head", "branch", "refs", "exclusions"].includes(key)) &&
    typeof value["head"] === "string" &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value["head"]) &&
    forgeBranch(value["branch"]) &&
    typeof value["refs"] === "string" &&
    value["refs"].length <= 1024 * 1024 &&
    (value["exclusions"] === undefined ||
      (typeof value["exclusions"] === "string" && /^[a-f0-9]{64}$/u.test(value["exclusions"])))
  );
}
