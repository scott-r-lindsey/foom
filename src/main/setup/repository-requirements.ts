import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readOwnedFile } from "../../node-common/owned-files";
import { atomicPrivate, privateDirectory } from "../../node-common/private-files";
import { keys, record } from "../../shared/remote-agent-protocol";
import type {
  RecordRepositoryRequirements,
  RepositoryRequirements,
  RepositoryRequirementsAction,
} from "../../shared/repository-requirements";
import { registeredRepositoryPath } from "../workspace/worktrees";
import type { WorktreeService } from "../workspace/worktrees";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const maxMarkdownBytes = 16 * 1024;
const maxFileBytes = 2 * maxMarkdownBytes + 2048;

function noteFile(repository: string, id: string): string {
  return createHash("sha256").update(repository).update("\0").update(id).digest("hex") + ".json";
}
function revision(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}
function markdown(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxMarkdownBytes &&
    Buffer.byteLength(value) <= maxMarkdownBytes &&
    value.trim().length > 0 &&
    !/[^\P{Cc}\t\r\n]|[\p{Cf}\p{Cs}]/u.test(value)
  );
}
function label(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    value.trim().length > 0 &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
  );
}
function date(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
  );
}
function savedNote(value: unknown): value is RepositoryRequirements {
  return (
    record(value) &&
    keys(value, ["markdown", "revision", "agent", "host", "recordedAt", "editedAt"]) &&
    markdown(value["markdown"]) &&
    revision(value["revision"]) &&
    label(value["agent"]) &&
    label(value["host"]) &&
    date(value["recordedAt"]) &&
    (value["editedAt"] === undefined || date(value["editedAt"]))
  );
}
interface ClearedRequirements {
  revision: string;
  cleared: true;
}

type StoredRequirements = RepositoryRequirements | ClearedRequirements;

function clearedNote(value: unknown): value is ClearedRequirements {
  return (
    record(value) &&
    keys(value, ["revision", "cleared"]) &&
    revision(value["revision"]) &&
    value["cleared"] === true
  );
}

function visibleNote(current: StoredRequirements | null): RepositoryRequirements | null {
  return current && "markdown" in current ? current : null;
}

function settingsAction(value: unknown): value is RepositoryRequirementsAction {
  if (!record(value) || !registeredRepositoryPath(value["repository"])) return false;
  if (value["action"] === "read") return keys(value, ["action", "repository"]);
  if (!revision(value["revision"])) return false;
  if (value["action"] === "clear") return keys(value, ["action", "repository", "revision"]);
  return (
    value["action"] === "edit" &&
    keys(value, ["action", "repository", "revision", "markdown"]) &&
    markdown(value["markdown"])
  );
}
function recordRequest(value: unknown): value is RecordRepositoryRequirements {
  return (
    record(value) &&
    keys(value, ["runId", "repository", "markdown"]) &&
    typeof value["runId"] === "string" &&
    registeredRepositoryPath(value["repository"]) &&
    markdown(value["markdown"])
  );
}

interface RequirementsRun {
  id: string;
  repositories: readonly string[];
  agent: string;
  host: string;
  record: boolean;
  signal: AbortSignal;
}

export class RepositoryRequirementsStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly profile: string,
    private readonly registrationIdentity: (path: string) => string,
    private readonly preserveRegistrationIdentity?: (path: string, id: string) => Promise<void>,
  ) {}

  private identity(path: string): string {
    const id = this.registrationIdentity(path);
    if (!revision(id)) throw new Error("Invalid repository registration");
    return id;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => undefined).then(work);
    this.pending = next;
    return next;
  }

  private async read(directory: string, name: string): Promise<StoredRequirements | null> {
    let input: unknown;
    try {
      input = JSON.parse(await readOwnedFile(join(directory, name), maxFileBytes));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw new Error("Unable to read host requirements", { cause: error });
    }
    if (!savedNote(input) && !clearedNote(input))
      throw new Error("Invalid saved host requirements");
    return input;
  }

  settings(input: unknown): Promise<RepositoryRequirements | null> {
    if (!settingsAction(input)) throw new Error("Invalid host requirements request");
    return this.serial(async () => {
      const id = this.identity(input.repository);
      const directory = await privateDirectory(this.profile, "repository-requirements");
      const name = noteFile(input.repository, id);
      const current = visibleNote(await this.read(directory, name));
      if (input.action === "read") return current;
      if (current?.revision !== input.revision || this.identity(input.repository) !== id)
        throw new Error("Host requirements changed");
      const next: StoredRequirements =
        input.action === "clear"
          ? { revision: randomUUID(), cleared: true }
          : {
              ...current,
              markdown: input.markdown,
              revision: randomUUID(),
              editedAt: Date.now(),
            };
      await atomicPrivate(directory, name, next, () => {
        if (this.identity(input.repository) !== id)
          throw new Error("Repository registration changed");
      });
      return visibleNote(next);
    });
  }

  /** Bind only to the authenticated setup run's endpoint and abort on exit or cancellation. */
  async forRun(run: RequirementsRun) {
    if (!label(run.agent) || !label(run.host) || !label(run.id))
      throw new Error("Invalid host setup run");
    const { id: runId, agent, host, signal, record: recording } = run;
    const selected = [...new Set(run.repositories)];
    if (selected.length > 1000 || !selected.every(registeredRepositoryPath))
      throw new Error("Invalid setup repositories");
    const scope = await this.serial(async () => {
      signal.throwIfAborted();
      const directory = await privateDirectory(this.profile, "repository-requirements");
      const scoped = new Map<string, { id: string; current: StoredRequirements | null }>();
      for (const repository of selected) {
        signal.throwIfAborted();
        const id = this.identity(repository);
        scoped.set(repository, {
          id,
          current: await this.read(directory, noteFile(repository, id)),
        });
      }
      signal.throwIfAborted();
      return scoped;
    });
    return {
      notes: [...scope].map(([repository, { current }]) => {
        const note = visibleNote(current);
        return { repository, note: note && { ...note } };
      }),
      write: recording
        ? (input: unknown) => {
            if (!recordRequest(input) || input.runId !== runId || !scope.has(input.repository))
              throw new Error("Host requirements write refused");
            return this.serial(async () => {
              signal.throwIfAborted();
              const entry = scope.get(input.repository);
              if (!entry || this.identity(input.repository) !== entry.id)
                throw new Error("Host requirements write refused");
              const directory = await privateDirectory(this.profile, "repository-requirements");
              const name = noteFile(input.repository, entry.id);
              const current = await this.read(directory, name);
              if (
                current?.revision !== entry.current?.revision ||
                this.identity(input.repository) !== entry.id
              )
                throw new Error("Host requirements changed");
              await this.preserveRegistrationIdentity?.(input.repository, entry.id);
              signal.throwIfAborted();
              const editedAt = visibleNote(current)?.editedAt;
              const next = {
                agent,
                host,
                markdown: input.markdown,
                revision: randomUUID(),
                recordedAt: Date.now(),
                ...(editedAt === undefined ? {} : { editedAt }),
              };
              await atomicPrivate(directory, name, next, () => {
                signal.throwIfAborted();
                if (this.identity(input.repository) !== entry.id)
                  throw new Error("Repository registration changed");
              });
              scope.set(input.repository, { id: entry.id, current: next });
            });
          }
        : undefined,
    };
  }
}

const stores = new WeakMap<WorktreeService, RepositoryRequirementsStore>();
export function repositoryRequirementsForProfile(profile: string, worktrees: WorktreeService) {
  let store = stores.get(worktrees);
  if (!store) {
    store = new RepositoryRequirementsStore(
      profile,
      (path) => worktrees.registrationIdentity(path),
      (path, id) => worktrees.preserveRegistrationIdentity(path, id),
    );
    stores.set(worktrees, store);
  }
  return store;
}
