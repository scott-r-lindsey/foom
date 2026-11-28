import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fitsMcpToolResponse } from "../../node-common/mcp-response";
import { atomicPrivate, verifyPrivate } from "../../node-common/private-files";
import { ControlError, exact, identifier, object } from "../../shared/control-validation";
import { conversationId } from "../../shared/conversation";
import type {
  DispatcherLaunch,
  DispatcherRepository,
  DispatcherLaunchLifecycle,
  DispatcherView,
} from "../../shared/dispatcher";
import { dispatcherLaunch, dispatcherRepositoryPath } from "../../shared/dispatcher-validation";
import type { WorkspaceTerminal } from "../../shared/workspace";
import type { ChildInput } from "../../shared/child-input-types";
import { isChildInput } from "../../shared/child-input";
import { readHandoffRequest } from "../../shared/handoff-validation";
import type { Handoff } from "../../shared/handoff";
import type { BoardDecisions, BoardMutation } from "../../shared/message-board";
import {
  boardAnswers,
  decisionAddress,
  OPEN_DECISION_LIMIT,
} from "../../shared/message-board-validation";
import { locationId, metadataName, type SessionMetadata } from "./metadata";
import type { MessageBoard } from "./message-board";
import type { Operations } from "./operations";
import type { Principal } from "./types";
import type { Operation } from "./types";

interface RepositoryProof {
  name: string;
  path: string;
  identity: string;
}
interface Adopted {
  id: string;
  path: string;
  identity: string;
  launched?: true;
}
interface Scope {
  id: string;
  directory: string;
  identity: string;
  restoreConversation?: string;
  approved: { path: string; identity: string }[];
  adopted: Adopted[];
}
interface GrantRequest {
  actor: Principal;
  input: DispatcherLaunch;
  repository: RepositoryProof;
  operations: Operations;
  operation: Operation;
  authorize: () => Scope;
}
interface PendingGrant extends GrantRequest {
  agentName: string;
}

export const DISPATCHER_METHODS = [
  "repos",
  "launch_orchestrator",
  "prompt",
  "stop",
  "session_state",
  "read_handoff",
  "wait_for",
  "operation_status",
];

const GRANT_OPTIONS = [
  { id: "add", label: "Allow and add to dispatcher repos" },
  { id: "once", label: "Allow once" },
  { id: "decline", label: "Don't launch" },
];

export interface DispatcherHost {
  directoryIdentity(path: string): Promise<string>;
  repository(directory: string, path: string): Promise<RepositoryProof>;
  repositories(directory: string): Promise<RepositoryProof[]>;
  validateHost(host: string): void;
  agentName(id: DispatcherLaunch["agent"]): string | undefined;
  launch(
    request: DispatcherLaunch,
    repository: RepositoryProof,
    dispatcher: string,
    validate: () => Promise<void>,
    active: () => void,
    lifecycle: DispatcherLaunchLifecycle,
  ): Promise<string>;
  prompt(id: string, input: ChildInput): Promise<void>;
  stop(id: string): Promise<void>;
  handoffs?(id: string): readonly Handoff[];
}

const REPOSITORY_LIMIT = 128;
const SCOPE_LIMIT = 64;
const STORAGE_LIMIT = 1024 * 1024;
const FILE_NAME = "dispatchers.json";

function proof(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0"))
    throw new ControlError("invalid_request");
  return value;
}

/** Old scopes stored direct child names. Preserve the saved checkout proof. */
function savedRepositoryPath(data: Record<string, unknown>, directory: string): string {
  if (data["name"] === undefined) {
    const path = dispatcherRepositoryPath(data["path"]);
    if (!isAbsolute(path)) throw new ControlError("invalid_request");
    return path;
  }
  const name = data["name"];
  if (
    data["path"] !== undefined ||
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 255 ||
    name.startsWith(".") ||
    /[ .]$/u.test(name) ||
    /[\\/:\p{Cc}\p{Cf}\p{Cs}]/u.test(name)
  )
    throw new ControlError("invalid_request");
  return dispatcherRepositoryPath(join(directory, name));
}

function savedScope(value: unknown): Scope {
  const row = object(value);
  exact(row, ["id", "directory", "identity", "approved", "adopted", "restoreConversation"]);
  const directory = proof(row["directory"]);
  if (!isAbsolute(directory) || /\p{Cc}/u.test(directory))
    throw new ControlError("invalid_request");
  const approved = row["approved"];
  const adopted = row["adopted"];
  const restoreConversation = row["restoreConversation"];
  if (
    !Array.isArray(approved) ||
    approved.length > REPOSITORY_LIMIT ||
    !Array.isArray(adopted) ||
    adopted.length > REPOSITORY_LIMIT ||
    (restoreConversation !== undefined && !conversationId(restoreConversation))
  )
    throw new ControlError("invalid_request");
  const scope: Scope = {
    id: identifier(row["id"]),
    directory,
    identity: proof(row["identity"]),
    ...(restoreConversation === undefined ? {} : { restoreConversation }),
    approved: approved.map((entry: unknown) => {
      const data = object(entry);
      exact(data, ["path", "name", "identity"]);
      return { path: savedRepositoryPath(data, directory), identity: proof(data["identity"]) };
    }),
    adopted: adopted.map((entry: unknown) => {
      const data = object(entry);
      exact(data, ["id", "path", "name", "identity", "launched"]);
      if (data["launched"] !== undefined && data["launched"] !== true)
        throw new ControlError("invalid_request");
      return {
        id: identifier(data["id"]),
        path: savedRepositoryPath(data, directory),
        identity: proof(data["identity"]),
        ...(data["launched"] === true ? { launched: true } : {}),
      };
    }),
  };
  if (
    new Set(scope.approved.map(({ path }) => path)).size !== scope.approved.length ||
    new Set(scope.adopted.map(({ id }) => id)).size !== scope.adopted.length
  )
    throw new ControlError("invalid_request");
  return scope;
}

export class Dispatcher {
  private readonly live = new Set<string>();
  private readonly recovery = new Map<string, string>();
  private quitRecovery: Map<string, string> | undefined;
  private scopes: Scope[];
  private readonly demoting = new Map<string, { exited: boolean }>();
  private readonly launching = new Set<string>();
  private readonly bindingReports = new Map<
    string,
    { repository: string; authorize: () => Scope }
  >();
  private readonly elevating = new Map<string, { directory: string; exited: boolean }>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: DispatcherHost,
    private readonly rows: () => readonly WorkspaceTerminal[],
    private readonly save: (state: unknown, validate: () => void) => Promise<void>,
    private readonly changed: () => void,
    scopes: Scope[] = [],
  ) {
    this.scopes = scopes.map(({ restoreConversation, ...scope }) => {
      if (restoreConversation !== undefined) this.recovery.set(scope.id, restoreConversation);
      return scope;
    });
  }

  static async open(
    directory: string,
    host: DispatcherHost,
    rows: () => readonly WorkspaceTerminal[],
    changed: () => void,
  ) {
    const path = join(directory, FILE_NAME);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    let scopes: Scope[] = [];
    if (info) {
      if (!info.isFile() || info.size > STORAGE_LIMIT) throw new ControlError("unavailable");
      await verifyPrivate(path, false);
      const file = await open(
        path,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      let data: unknown;
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.dev !== info.dev ||
          stat.ino !== info.ino ||
          stat.size > STORAGE_LIMIT
        )
          throw new ControlError("unavailable");
        const bytes = Buffer.alloc(STORAGE_LIMIT + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > STORAGE_LIMIT) throw new ControlError("unavailable");
        data = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      } finally {
        await file.close();
      }
      const record = object(data);
      exact(record, ["version", "scopes"]);
      const entries = record["scopes"];
      if (record["version"] !== 1 || !Array.isArray(entries) || entries.length > SCOPE_LIMIT)
        throw new ControlError("unavailable");
      scopes = entries.map(savedScope);
      if (
        new Set(scopes.map(({ id }) => id)).size !== scopes.length ||
        new Set(scopes.map(({ directory }) => directory)).size !== scopes.length
      )
        throw new ControlError("unavailable");
    }
    const dispatcher = new Dispatcher(
      host,
      rows,
      (state, validate) => atomicPrivate(directory, FILE_NAME, state, validate),
      changed,
      scopes,
    );
    // Consume recovery before the hub can spawn any source invocations.
    if (dispatcher.recovery.size)
      await dispatcher.write(
        (current) => current,
        () => {},
      );
    return dispatcher;
  }

  private async write(
    update: (current: Scope[]) => Scope[],
    validate: () => void,
    commit?: () => void,
  ) {
    const task = this.writes.then(async () => {
      validate();
      const scopes = update(this.scopes).map(savedScope);
      const state = { version: 1, scopes };
      if (scopes.length > SCOPE_LIMIT || Buffer.byteLength(JSON.stringify(state)) > STORAGE_LIMIT)
        throw new ControlError("capacity");
      await this.save(state, validate);
      try {
        commit?.();
      } catch (error) {
        // Keep rollback in the write queue so it cannot overwrite another scope update.
        await this.save({ version: 1, scopes: this.scopes }, () => {});
        throw error;
      }
      this.scopes = scopes;
    });
    this.writes = task.catch(() => undefined);
    await task;
  }

  private runningSource(id: string): WorkspaceTerminal | undefined {
    const row = this.rows().find((row) => row.id === id);
    if (row?.sourceSession !== true || row.exited || row.dormant || row.kind !== "agent")
      return undefined;
    return row;
  }

  private row(id: string): WorkspaceTerminal {
    const row = this.runningSource(id);
    if (!row) throw new ControlError("not_found");
    return row;
  }

  private owned(scope: Scope, rows = this.rows(), includeExited = false) {
    return rows.filter((row) => {
      if (row.kind !== "agent") return false;
      const role = row.orchestration;
      // The saved adoption identifies exited rows even when restart removes their role view.
      const eligible = row.exited
        ? includeExited && (role === undefined || role.role === "orchestrator")
        : role?.role === "orchestrator" && role.active;
      return (
        eligible &&
        scope.adopted.some((target) => target.id === row.id && target.path === row.repository)
      );
    });
  }

  view(id: string, rows: readonly WorkspaceTerminal[]): DispatcherView | undefined {
    if (!this.live.has(id)) return undefined;
    const scope = this.scopes.find((scope) => scope.id === id);
    if (!scope) return undefined;
    const owned = this.owned(scope, rows);
    const managed = new Set([
      ...scope.approved.map(({ path }) => path),
      ...owned.map((row) => row.repository),
    ]);
    return { orchestrators: owned.length, repositories: managed.size };
  }

  canReport(actor: Principal): boolean {
    if (actor.role !== "orchestrator" || actor.parentId !== null) return false;
    const binding = this.bindingReports.get(actor.terminalId);
    if (binding?.repository === actor.repository) {
      try {
        binding.authorize();
        return true;
      } catch {
        return false;
      }
    }
    return this.scopes.some(
      (scope) =>
        this.live.has(scope.id) &&
        scope.adopted.some(
          (entry) =>
            entry.launched && entry.id === actor.terminalId && entry.path === actor.repository,
        ),
    );
  }

  async elevate(
    id: string,
    select: (
      directory: string,
      repositories: readonly DispatcherRepository[],
    ) => Promise<readonly string[] | undefined>,
    setRole: (id: string, role: "agent" | "dispatcher") => void,
    checkSource: () => void = () => {},
  ): Promise<void> {
    const directory = this.row(id).worktree;
    const elevation = { directory, exited: false };
    const validate = () => {
      checkSource();
      if (elevation.exited) throw new ControlError("not_found");
      if (this.quitRecovery) throw new ControlError("unavailable");
      if (
        this.row(id).worktree !== directory ||
        this.scopes.some(
          (scope) =>
            scope.directory === directory &&
            (this.live.has(scope.id) || this.demoting.has(scope.id)),
        )
      )
        throw new ControlError("conflict");
    };
    if ([...this.elevating.values()].some((pending) => pending.directory === directory))
      throw new ControlError("conflict");
    this.elevating.set(id, elevation);
    try {
      validate();
      const identity = await this.host.directoryIdentity(directory);
      validate();
      const repositories = await this.host.repositories(directory);
      validate();
      const current = this.rows();
      const chosen = await select(
        directory,
        repositories.map(({ name, path }) => ({
          name,
          path,
          running: current.some(
            (row) =>
              row.repository === path &&
              row.orchestration?.role === "orchestrator" &&
              row.orchestration.active &&
              !row.exited,
          ),
        })),
      );
      validate();
      if (chosen === undefined) return;
      if (chosen.length > REPOSITORY_LIMIT) throw new ControlError("capacity");
      const approved: Scope["approved"] = [];
      const adopted: Adopted[] = [];
      for (const path of chosen) {
        const previous = repositories.find((repo) => repo.path === path);
        if (!previous) throw new ControlError("invalid_request");
        const repository = await this.host.repository(directory, path);
        validate();
        if (repository.identity !== previous.identity) throw new ControlError("conflict");
        approved.push({ path, identity: repository.identity });
        for (const candidate of this.rows()) {
          if (
            candidate.repository !== repository.path ||
            candidate.orchestration?.role !== "orchestrator" ||
            !candidate.orchestration.active ||
            candidate.exited
          )
            continue;
          adopted.push({ id: candidate.id, path, identity: repository.identity });
        }
      }
      if ((await this.host.directoryIdentity(directory)) !== identity)
        throw new ControlError("conflict");
      await this.write(
        (current) => [
          ...current.filter((scope) => scope.directory !== directory),
          savedScope({ id, directory, identity, approved, adopted }),
        ],
        validate,
        () => {
          validate();
          setRole(id, "dispatcher");
          this.live.add(id);
        },
      );
      this.changed();
    } finally {
      this.elevating.delete(id);
    }
  }

  prepareQuit(): void {
    this.quitRecovery = new Map();
    for (const row of this.rows())
      if (this.live.has(row.id) && !row.exited && !row.dormant && row.conversationId)
        this.quitRecovery.set(row.id, row.conversationId);
  }

  cancelQuit(): void {
    this.quitRecovery = undefined;
  }

  async finishQuit(): Promise<void> {
    const recovery = this.quitRecovery;
    if (!recovery?.size) return;
    await this.write(
      (scopes) =>
        scopes.map((scope) => {
          const restoreConversation = recovery.get(scope.id);
          return restoreConversation ? { ...scope, restoreConversation } : scope;
        }),
      () => {},
    );
  }

  async revive(
    id: string,
    conversation: string | undefined,
    setRole: (id: string, role: "dispatcher") => void,
  ): Promise<boolean> {
    const saved = this.recovery.get(id);
    this.recovery.delete(id);
    if (!saved || saved !== conversation) return false;
    const scope = this.scopes.find((scope) => scope.id === id);
    if (!scope) return false;
    const row = this.runningSource(id);
    if (
      !row ||
      row.worktree !== scope.directory ||
      row.conversationId !== saved ||
      (await this.host.directoryIdentity(scope.directory).catch(() => undefined)) !== scope.identity
    )
      return false;
    const current = this.runningSource(id);
    if (
      !current ||
      current.worktree !== row.worktree ||
      current.conversationId !== saved ||
      current.launchVersion !== row.launchVersion ||
      this.live.has(id) ||
      this.demoting.has(id) ||
      this.scopes.find((candidate) => candidate.id === id) !== scope
    )
      return false;
    setRole(id, "dispatcher");
    this.live.add(id);
    this.changed();
    return true;
  }

  async demote(id: string, setRole: (id: string, role: "agent") => void): Promise<void> {
    if (!this.live.has(id)) throw new ControlError("not_found");
    this.live.delete(id);
    this.quitRecovery?.delete(id);
    const demotion = { exited: false };
    this.demoting.set(id, demotion);
    try {
      await this.write(
        (scopes) => scopes.filter((scope) => scope.id !== id),
        () => {},
      );
    } catch (error) {
      if (!demotion.exited) this.live.add(id);
      throw error;
    } finally {
      this.demoting.delete(id);
    }
    setRole(id, "agent");
    this.clearRequests(id);
    this.changed();
  }

  exited(id: string) {
    this.recovery.delete(id);
    const elevation = this.elevating.get(id);
    if (elevation) elevation.exited = true;
    const demotion = this.demoting.get(id);
    if (demotion) demotion.exited = true;
    if (!this.live.delete(id) && !demotion) return;
    this.clearRequests(id);
    this.changed();
  }

  private clearRequests(id: string) {
    for (const [post, request] of this.requests)
      if (request.actor.terminalId === id) this.requests.delete(post);
  }

  private scope(actor: Principal): Scope {
    const scope = this.scopes.find((scope) => scope.id === actor.terminalId);
    if (
      actor.role !== "dispatcher" ||
      !scope ||
      !this.live.has(scope.id) ||
      actor.worktree !== scope.directory
    )
      throw new ControlError("forbidden");
    return scope;
  }

  static decisionScope(id: string): string {
    return locationId(JSON.stringify(["dispatcher", id]));
  }
  private readonly requests = new Map<string, PendingGrant>();
  private readonly answering = new Set<string>();
  private readonly answers = new Map<
    string,
    {
      fingerprint: string;
      receipt: BoardMutation;
      attempted: number;
      result?: Promise<BoardMutation>;
    }
  >();

  private async currentRepository(scope: Scope, path: string) {
    if ((await this.host.directoryIdentity(scope.directory)) !== scope.identity)
      throw new ControlError("conflict");
    const repository = await this.host.repository(scope.directory, path);
    if ((await this.host.directoryIdentity(scope.directory)) !== scope.identity)
      throw new ControlError("conflict");
    return repository;
  }

  async call(
    actor: Principal,
    method: string,
    params: Record<string, unknown>,
    operations: Operations,
    metadata: SessionMetadata,
    board: MessageBoard | undefined,
    active: () => void,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const authorize = () => {
      active();
      return this.scope(actor);
    };
    const scope = authorize();
    if (method === "repos") {
      exact(params, ["after", "limit"]);
      const limit = params["limit"] ?? 16;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 16)
        throw new ControlError("invalid_request");
      const after =
        params["after"] === undefined ? undefined : dispatcherRepositoryPath(params["after"]);
      if ((await this.host.directoryIdentity(scope.directory)) !== scope.identity)
        throw new ControlError("conflict");
      const repos = await this.host.repositories(scope.directory);
      if ((await this.host.directoryIdentity(scope.directory)) !== scope.identity)
        throw new ControlError("conflict");
      authorize();
      const start = after === undefined ? 0 : repos.findIndex(({ path }) => path === after) + 1;
      if (after !== undefined && start === 0) throw new ControlError("not_found");
      const rows = this.rows();
      const project = (repository: RepositoryProof) => {
        const id = locationId(repository.path);
        const preApproved = scope.approved.some(
          (item) => item.path === repository.path && item.identity === repository.identity,
        );
        const decisions = board?.decisions({ repository: id, watch: [] });
        const related = rows.filter((row) => row.repository === repository.path);
        const targets = related.filter(
          (row) =>
            row.orchestration?.role === "orchestrator" && row.orchestration.active && !row.exited,
        );
        const adopted = this.owned(scope, targets);
        const states = metadata.states(
          { ...actor, repository: repository.path },
          related.map(({ id }) => id),
        );
        const byId = new Map(states.map((state) => [state.id, state]));
        const pullRequests = new Map(
          states.flatMap(({ pullRequest }) =>
            pullRequest
              ? [
                  [
                    pullRequest.number,
                    {
                      number: pullRequest.number,
                      state: pullRequest.state,
                      checks: pullRequest.requiredChecks,
                    },
                  ] as const,
                ]
              : [],
          ),
        );
        return {
          name: metadataName(repository.name),
          repo: repository.path,
          preApproved,
          pullRequests: [...pullRequests.values()].slice(0, 16),
          orchestrators: targets.map((row) => {
            const state = byId.get(row.id);
            return {
              id: row.id,
              adopted: adopted.includes(row),
              host: state?.host ?? null,
              agent: row.agent,
              state: state?.state,
              pullRequest: state?.pullRequest ?? null,
              decisionCount: decisions?.counts[id] ?? 0,
              questions: decisions?.questions.map(({ question }) => question.title) ?? [],
            };
          }),
        };
      };
      const page: ReturnType<typeof project>[] = [];
      let nextCursor: string | null = null;
      for (const repository of repos.slice(start, start + limit)) {
        const entry = project(repository);
        const next = start + page.length + 1 < repos.length ? entry.repo : null;
        if (!fitsMcpToolResponse({ repos: [...page, entry], nextCursor: next, untrusted: true })) {
          if (!page.length) throw new ControlError("capacity");
          break;
        }
        page.push(entry);
        nextCursor = next;
      }
      return { repos: page, nextCursor, untrusted: true };
    }
    if (method === "launch_orchestrator") {
      const input = dispatcherLaunch(params);
      const payload = JSON.stringify(input);
      const replay = operations.replay(
        actor,
        "launch",
        input.idempotencyKey,
        payload,
        undefined,
        true,
      );
      if (replay) return replay;
      const repository = await this.currentRepository(scope, input.repo);
      authorize();
      if (input.host !== undefined) this.host.validateHost(input.host);
      const operation = await operations.begin(
        actor,
        "launch",
        input.idempotencyKey,
        payload,
        locationId(repository.path),
        true,
      );
      if (!operation.created)
        return operations.lookup(actor, { operationId: operation.operationId });
      const request = { actor, input, repository, operation, operations, authorize };
      try {
        const current = authorize();
        if (
          current.approved.some(
            (entry) => entry.path === repository.path && entry.identity === repository.identity,
          )
        )
          return await this.launch(request, false);
        if (
          [...this.requests.values()].filter((entry) => entry.actor.terminalId === actor.terminalId)
            .length >= OPEN_DECISION_LIMIT
        )
          throw new ControlError("capacity");
        const agentName = this.host.agentName(input.agent);
        if (!agentName) throw new ControlError("not_found");
        this.requests.set(operation.operationId, {
          ...request,
          agentName: metadataName(agentName),
        });
        this.changed();
        return operations.lookup(actor, { operationId: operation.operationId });
      } catch {
        return operations.finish(actor, operation.operationId, "failed", "refused");
      }
    }
    if (method === "operation_status") return operations.lookup(actor, params);
    const target = async (id: string, includeExited = false) => {
      const current = authorize();
      const candidate = current.adopted.find((target) => target.id === id);
      if (!candidate) throw new ControlError("not_found");
      const repository = await this.currentRepository(current, candidate.path);
      if (repository.identity !== candidate.identity) throw new ControlError("not_found");
      const row = this.owned(authorize(), undefined, includeExited).find((row) => row.id === id);
      if (!row || row.repository !== repository.path) throw new ControlError("not_found");
      return row;
    };
    if (method === "wait_for") {
      exact(params, ["ids", "after", "timeoutMs"]);
      const ids = params["ids"];
      const timeout = params["timeoutMs"] ?? 0;
      if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > 16 ||
        typeof timeout !== "number" ||
        !Number.isInteger(timeout) ||
        timeout < 0 ||
        timeout > 30000
      )
        throw new ControlError("invalid_request");
      const targets = ids.map(identifier);
      if (new Set(targets).size !== targets.length) throw new ControlError("invalid_request");
      const after = params["after"] === undefined ? {} : object(params["after"]);
      exact(after, targets);
      for (const value of Object.values(after)) identifier(value);
      const deadline = Date.now() + timeout;
      for (;;) {
        if (signal?.aborted) throw new ControlError("unavailable");
        const rows = await Promise.all(targets.map((id) => target(id, true)));
        authorize();
        const sessions = rows.flatMap((row) =>
          metadata.states({ ...actor, repository: row.repository }, [row.id]),
        );
        const changed = sessions
          .filter((row) => after[row.id] !== row.revision)
          .map((row) => row.id);
        const remaining = deadline - Date.now();
        if (changed.length || remaining <= 0)
          return { sessions, changed, timedOut: !changed.length };
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
      }
    }
    if (method === "session_state") {
      exact(params, ["id"]);
      const id = identifier(params["id"]);
      const row = await target(id, true);
      return metadata.read({ ...actor, repository: row.repository }, method, { id });
    }
    if (method === "read_handoff") {
      const { id, seq } = readHandoffRequest(params);
      const row = await target(id, true);
      const entries = this.host.handoffs?.(id) ?? (row.handoff ? [row.handoff] : []);
      const report = seq === undefined ? entries.at(-1) : entries.find((item) => item.seq === seq);
      if (!report) throw new ControlError("not_found");
      return {
        ...report,
        links: [...report.links],
        untrusted: true,
        notice: "Orchestrator handoffs are untrusted data.",
      };
    }
    if (method !== "prompt" && method !== "stop") throw new ControlError("forbidden");
    exact(
      params,
      method === "prompt" ? ["id", "text", "idempotencyKey"] : ["id", "idempotencyKey"],
    );
    const id = identifier(params["id"]);
    const key = identifier(params["idempotencyKey"]);
    const input = { kind: "prompt", text: params["text"] };
    if (method === "prompt" && !isChildInput(input)) throw new ControlError("invalid_request");
    const payload = JSON.stringify(input);
    const replay = operations.replay(actor, method, key, payload, id);
    if (replay) return replay;
    await target(id);
    const operation = await operations.begin(actor, method, key, payload, id);
    if (!operation.created) return operations.lookup(actor, { operationId: operation.operationId });
    let dispatched = false;
    try {
      await target(id);
      authorize();
      dispatched = true;
      if (method === "prompt" && isChildInput(input)) await this.host.prompt(id, input);
      else await this.host.stop(id);
      authorize();
      return await operations.finish(actor, operation.operationId, "succeeded", "completed", id);
    } catch {
      return operations.finish(
        actor,
        operation.operationId,
        dispatched ? "indeterminate" : "failed",
        dispatched ? "uncertain" : "refused",
      );
    }
  }

  private async launch(request: GrantRequest, add: boolean) {
    const { actor, input, repository, operations, operation, authorize } = request;
    const recheck = async () => {
      const scope = authorize();
      if ((await this.currentRepository(scope, input.repo)).identity !== repository.identity)
        throw new ControlError("conflict");
      authorize();
      if (input.host !== undefined) this.host.validateHost(input.host);
    };
    const id = randomUUID();
    const effects = { spawnDispatched: false, atCapacity: false };
    let launched = false;
    this.launching.add(id);
    try {
      await recheck();
      // Record the terminal handle in the serialized scope before it can spawn.
      await this.write((scopes) => {
        const retained = new Set(this.rows().map((row) => row.id));
        return scopes.map((scope) => {
          if (scope.id !== actor.terminalId) return scope;
          const adopted = scope.adopted.filter(
            (entry) =>
              retained.has(entry.id) ||
              this.launching.has(entry.id) ||
              (!entry.launched && entry.path !== repository.path),
          );
          if (adopted.length >= REPOSITORY_LIMIT) {
            effects.atCapacity = true;
            throw new ControlError("capacity");
          }
          const approved = add
            ? [
                ...scope.approved.filter(({ path }) => path !== repository.path),
                { path: repository.path, identity: repository.identity },
              ]
            : scope.approved;
          adopted.push({
            id,
            path: repository.path,
            identity: repository.identity,
            launched: true,
          });
          return { ...scope, approved, adopted };
        });
      }, authorize);
      await operations.finish(actor, operation.operationId, "running", "intent");
      await recheck();
      const actualId = await this.host.launch(
        input,
        repository,
        actor.terminalId,
        recheck,
        authorize,
        {
          terminalId: id,
          spawning: () => {
            effects.spawnDispatched = true;
          },
          binding: (boundId) => {
            if (boundId !== id) throw new ControlError("conflict");
            this.bindingReports.set(id, { repository: repository.path, authorize });
          },
        },
      );
      if (actualId !== id) throw new ControlError("conflict");
      authorize();
      this.changed();
      launched = true;
    } catch {
      // The spawn boundary determines whether the launch can have taken effect.
    } finally {
      this.bindingReports.delete(id);
      this.launching.delete(id);
    }
    if (launched)
      return operations.finish(actor, operation.operationId, "succeeded", "completed", id);
    if (effects.spawnDispatched)
      return operations.finish(actor, operation.operationId, "indeterminate", "uncertain", id);
    return operations.finish(
      actor,
      operation.operationId,
      "failed",
      effects.atCapacity ? "dispatcher_capacity" : "refused",
    );
  }

  decisions(value: unknown, board: BoardDecisions): BoardDecisions {
    const input = object(value);
    const repository = input["repository"];
    const watch = input["watch"];
    if (!Array.isArray(watch) || watch.length > OPEN_DECISION_LIMIT)
      throw new ControlError("invalid_request");
    const watched = new Set(
      watch
        .map(decisionAddress)
        .filter(({ index }) => index === 0)
        .map(({ post }) => post),
    );
    const counts = { ...board.counts };
    const questions = [...board.questions];
    const orchestrators = { ...board.orchestrators };
    for (const id of this.live) orchestrators[id] = Dispatcher.decisionScope(id);
    for (const [post, request] of this.requests) {
      const scope = Dispatcher.decisionScope(request.actor.terminalId);
      counts[scope] = (counts[scope] ?? 0) + 1;
      if (repository === scope || watched.has(post))
        questions.push({
          post,
          index: 0,
          repository: scope,
          grant: true,
          status: "open",
          question: {
            title: `Launch ${request.agentName} orchestrator${request.input.host ? ` on ${request.input.host}` : ""} in ${request.repository.name}`,
            ...(request.input.reason ? { detail: request.input.reason } : {}),
            options: GRANT_OPTIONS.map((option) => ({ ...option })),
          },
        });
    }
    return { counts, questions, orchestrators };
  }

  answer(value: unknown): Promise<BoardMutation> | undefined {
    const input = boardAnswers(value);
    const fingerprint = JSON.stringify(input);
    const replay = this.answers.get(input.idempotencyKey);
    if (replay && replay.fingerprint !== fingerprint) throw new ControlError("conflict");
    if (replay?.result) return replay.result;
    if (!replay && !input.answers.some(({ post }) => this.requests.has(post))) return;
    const answers = input.answers.slice(replay?.attempted ?? 0).map(({ post, index, option }) => {
      const request = this.requests.get(post);
      if (!request || index !== 0 || !GRANT_OPTIONS.some(({ id }) => id === option))
        throw new ControlError("invalid_request");
      if (this.answering.has(post)) throw new ControlError("conflict");
      request.authorize();
      return { post, request, option };
    });
    let batch = replay;
    if (!batch) {
      if (this.answers.size >= 4096) throw new ControlError("capacity");
      const first = answers[0];
      if (!first) throw new ControlError("invalid_request");
      const thread = Dispatcher.decisionScope(first.request.actor.terminalId);
      batch = { fingerprint, attempted: 0, receipt: { thread, post: first.post } };
      this.answers.set(input.idempotencyKey, batch);
    }
    const completion = batch;
    for (const { post } of answers) this.answering.add(post);
    const result = Promise.resolve().then(async () => {
      try {
        for (const { post, request, option } of answers) {
          request.authorize();
          // A write failure records an indeterminate outcome for this grant.
          // Consume only the attempted prefix so a retry can settle the suffix.
          completion.attempted++;
          this.requests.delete(post);
          this.changed();
          if (option === "decline") {
            await request.operations.finish(
              request.actor,
              request.operation.operationId,
              "declined",
              "refused",
            );
          } else {
            await this.launch(request, option === "add");
          }
        }
        return completion.receipt;
      } catch (error) {
        delete completion.result;
        throw error;
      } finally {
        for (const { post } of answers) this.answering.delete(post);
      }
    });
    completion.result = result;
    return result;
  }
}
