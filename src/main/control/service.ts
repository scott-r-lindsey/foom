import { boardPost, boardResolve } from "../../shared/message-board-validation";
import type { MessageBoard } from "./message-board";
import { launchReasons } from "../../shared/launch-failure";
import { remoteChildControl } from "./remote-control";
import { removalReasons } from "../workspace/worktree-outcome";
import { reserveRequest } from "./http-limits";
import { bundledManual } from "./manual";
import { PREVIEW_METHODS } from "./previews";
import type { PreviewBroker } from "./previews";
import type { McpConnection } from "../../shared/workspace";

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { locationId, metadataName, SessionMetadata } from "./metadata";
import { basename } from "node:path";
import type { WorkspaceTerminal } from "../../shared/workspace";
import { isAbsolute } from "node:path";
import { ControlError, exact, identifier, object } from "../../shared/control-validation";
import type { ControlLaunch, Principal, Role } from "./types";
import type { Operations } from "./operations";
import { ORCHESTRATION_METHODS } from "./orchestration";
import type { Orchestration } from "./orchestration";

/** Allow client startup and managed-policy evaluation before showing attachment failure. */
export const MCP_CONNECTION_DEADLINE_MS = 30000;

export const BOARD_METHODS = ["board_threads", "board_read", "board_post", "board_resolve"];

const READ_ONLY = ["whoami", "sessions", "session_state"];

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

interface Grant {
  digest: Buffer;
  principal: Principal | null;
  calls: number;
  expiresAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  mcp?: McpConnection;
  mcpTimer?: ReturnType<typeof setTimeout>;
}

/** Main owns roles and scope. Adapters can only authenticate and dispatch validated requests. */
export class ControlService {
  readonly instanceId = randomUUID();
  private readonly grants = new Map<string, Grant>();
  private readonly unknown = digest(randomBytes(32).toString("hex"));
  private closed = false;
  private readonly metadata: SessionMetadata;
  constructor(
    readonly operations: Operations,
    source: () => readonly WorkspaceTerminal[] = () => [],
    private readonly orchestration?: Pick<Orchestration, "call"> &
      Partial<
        Pick<
          Orchestration,
          | "authorizeBoard"
          | "setBoard"
          | "hosts"
          | "bindAutomation"
          | "childLimit"
          | "pullRequest"
          | "canHandoff"
          | "handoffMetadata"
          | "reviewMetadata"
          | "childRead"
          | "childEvents"
        >
      >,
    private readonly connectionChanged: (
      id: string,
      state: McpConnection | undefined,
    ) => void = () => undefined,
    private readonly refused: (
      actor: Principal,
      method: string,
      status: "refused" | "succeeded",
      target: string | null,
    ) => Promise<void> = () => Promise.resolve(),
    readonly previews?: PreviewBroker,
    readonly board?: MessageBoard,
  ) {
    if (board) this.orchestration?.setBoard?.(board);
    this.metadata = new SessionMetadata(
      source,
      (row) => this.orchestration?.pullRequest?.(row),
      (row) => this.orchestration?.handoffMetadata?.(row),
      (row) => this.orchestration?.reviewMetadata?.(row) ?? row.review,
    );
  }

  boardChanged(): void {
    this.orchestration?.childEvents?.publish();
  }

  childLimit(): number {
    return this.orchestration?.childLimit?.() ?? 4;
  }

  prepare(
    repository: string,
    worktree: string,
    role: Role = "agent",
    parentId: string | null = null,
    sessionId?: string,
  ): ControlLaunch {
    if (this.closed) throw new ControlError("unavailable");
    if (
      ![repository, worktree].every(
        (path) => isAbsolute(path) && path.length <= 4096 && !/\p{Cc}/u.test(path),
      ) ||
      !["agent", "orchestrator", "cli"].includes(role)
    )
      throw new ControlError("invalid_request");
    if (parentId !== null) identifier(parentId);
    if (sessionId !== undefined) identifier(sessionId);
    const generation = randomUUID();
    const token = randomBytes(32).toString("hex");
    const grant: Grant = { digest: digest(token), principal: null, calls: 0 };
    this.grants.set(generation, grant);
    return {
      remoteCall: remoteChildControl(this, () => {
        if (!grant.principal) throw new ControlError("unauthorized");
        return grant.principal;
      }),
      env: Object.freeze({
        FOOM_CONTROL_TOKEN: token,
        FOOM_CONTROL_INSTANCE: this.instanceId,
        FOOM_SESSION: sessionId ?? generation,
      }),
      bind: (terminalId, mcp = false) => {
        identifier(terminalId);
        if (this.grants.get(generation) !== grant || grant.principal)
          throw new ControlError("unauthorized");
        grant.principal = Object.freeze({
          generation,
          grantedAt: new Date().toISOString(),
          sessionId: sessionId ?? generation,
          repository,
          worktree,
          role,
          parentId,
          terminalId,
        });
        this.orchestration?.bindAutomation?.(grant.principal, this.operations);
        if (mcp) {
          grant.mcp = "connecting";
          grant.mcpTimer = setTimeout(() => {
            grant.mcp = "not-connected";
            this.connectionChanged(terminalId, "not-connected");
          }, MCP_CONNECTION_DEADLINE_MS);
          grant.mcpTimer.unref();
          this.connectionChanged(terminalId, "connecting");
        }
      },
      dispose: () => {
        if (this.grants.get(generation) !== grant) return;
        if (grant.principal) {
          this.operations.revoke(grant.principal);
          this.previews?.revoke(grant.principal);
        }
        clearTimeout(grant.timer);
        clearTimeout(grant.mcpTimer);
        if (grant.principal) this.connectionChanged(grant.principal.terminalId, undefined);
        this.grants.delete(generation);
        this.orchestration?.childEvents?.publish();
      },
    };
  }

  /** Called only by the MCP adapter after a successful authenticated request. */
  mcpConnected(actor: Principal): void {
    this.assertActive(actor);
    const grant = this.grants.get(actor.generation);
    if (!grant?.mcp || grant.mcp === "connected") return;
    clearTimeout(grant.mcpTimer);
    grant.mcp = "connected";
    this.connectionChanged(actor.terminalId, "connected");
  }

  grantCli(repository: string): { token: string; expiresAt: number } {
    if ([...this.grants.values()].filter((grant) => grant.principal?.role === "cli").length >= 4)
      throw new ControlError("capacity");
    const launch = this.prepare(repository, repository, "cli");
    launch.bind(randomUUID());
    const token = launch.env["FOOM_CONTROL_TOKEN"] ?? "";
    const actor = this.authenticate(token);
    const grant = this.grants.get(actor.generation);
    if (!grant) throw new ControlError("unauthorized");
    const expiresAt = Date.now() + 600000;
    grant.expiresAt = expiresAt;
    grant.timer = setTimeout(() => {
      launch.dispose();
    }, 600000);
    grant.timer.unref();
    return { token, expiresAt };
  }

  authenticate(token: string): Principal {
    const candidate = digest(token);
    let found: Principal | undefined;
    // No caller-selected role/session, and no token stored in the lookup table.
    for (const grant of this.grants.values()) {
      if (timingSafeEqual(candidate, grant.digest) && grant.principal) found = grant.principal;
    }
    timingSafeEqual(candidate, this.unknown);
    if (!found) throw new ControlError("unauthorized");
    this.assertActive(found);
    return found;
  }

  assertActive(actor: Principal): void {
    const grant = this.grants.get(actor.generation);
    if (
      grant?.principal !== actor ||
      (grant.expiresAt !== undefined && Date.now() >= grant.expiresAt)
    )
      throw new ControlError("unauthorized");
  }

  authorize(actor: Principal, repository: string, parentId?: string): void {
    this.assertActive(actor);
    if (
      actor.repository !== repository ||
      (parentId !== undefined && parentId !== actor.terminalId)
    )
      throw new ControlError("not_found");
  }

  reserve(actor: Principal): () => void {
    this.assertActive(actor);
    const grant = this.grants.get(actor.generation);
    if (!grant) throw new ControlError("unauthorized");
    return reserveRequest(grant);
  }

  dispatch(actor: Principal, input: unknown): unknown {
    this.assertActive(actor);
    const request = object(input);
    exact(request, ["version", "instanceId", "method", "params"]);
    if (request["version"] !== 1 || request["instanceId"] !== this.instanceId)
      throw new ControlError("invalid_request");
    const params = object(request["params"]);
    switch (request["method"]) {
      case "release_cli": {
        exact(params, []);
        if (actor.role !== "cli") throw new ControlError("forbidden");
        clearTimeout(this.grants.get(actor.generation)?.timer);
        this.grants.delete(actor.generation);
        return { released: true };
      }
      case "manual":
        if (actor.role === "cli") throw new ControlError("forbidden");
        return bundledManual().read(params);
      case "whoami":
        exact(params, []);
        return {
          ...actor,
          repository: locationId(actor.repository),
          worktree: locationId(actor.worktree),
          name: metadataName(basename(actor.worktree)),
          removalReasons,
          launchReasons,
          capabilities: this.capabilities(actor),
          tools: this.capabilities(actor).map((name) => ({
            name,
            ...(name === "manual"
              ? {}
              : {
                  cli: `foom ${name.startsWith("board_") ? name.replace("board_", "board ") : name === "list_previews" ? "previews" : name.replaceAll("_", "-")}`,
                }),
            ...(name === "wait_for"
              ? {
                  longWait:
                    "foom wait-for [ID...] --until-event [--after JSON_ID_TO_EVENT] [--timeout SECONDS]",
                }
              : {}),
          })),
        };
      case "sessions":
      case "session_state": {
        const result = this.metadata.read(actor, request["method"], params);
        this.assertActive(actor);
        if (request["method"] === "session_state")
          this.orchestration?.childRead?.(actor, identifier(params["id"]));
        return result;
      }
      case "operation_status":
        if (actor.role !== "orchestrator") throw new ControlError("forbidden");
        return this.operations.lookup(actor, params);
      default:
        throw new ControlError("forbidden");
    }
  }

  /**
   * Main-only: the human makes a running session the orchestrator or revokes it. The token
   * stays and the next request sees the new principal; the old one stops authenticating, so
   * a revoked orchestrator's in-flight operations end as they do when it exits.
   */
  setRole(terminalId: string, role: "agent" | "orchestrator"): void {
    if (this.closed) throw new ControlError("unavailable");
    identifier(terminalId);
    const grant = [...this.grants.values()].find(
      (entry) => entry.principal?.terminalId === terminalId && entry.principal.role !== "cli",
    );
    const current = grant?.principal;
    // An exited session has nothing left to revoke.
    if (!grant || !current) {
      if (role === "agent") return;
      throw new ControlError("not_found");
    }
    if (current.role === role) return;
    this.orchestration?.childEvents?.publish();
    grant.principal = Object.freeze({
      ...current,
      role,
      parentId: null,
      grantedAt: new Date().toISOString(),
    });
    this.orchestration?.bindAutomation?.(grant.principal, this.operations);
    if (current.role === "orchestrator") {
      this.operations.revoke(current);
      this.previews?.revoke(current);
    }
  }

  takeOver(terminalId: string): void {
    this.previews?.takeOver(
      terminalId,
      [...this.grants.values()].flatMap((grant) => (grant.principal ? [grant.principal] : [])),
    );
  }

  /** Whether a grant generation still has a principal; protocol state lives no longer. */
  live(generation: string): boolean {
    const grant = this.grants.get(generation);
    if (!grant?.principal) return false;
    try {
      this.assertActive(grant.principal);
      return true;
    } catch {
      return false;
    }
  }

  /** Granted methods. Orchestration methods need a main-granted orchestrator principal. */
  capabilities(actor: Principal): string[] {
    const views = actor.role === "cli" ? [] : ["manual", ...PREVIEW_METHODS];
    return actor.role === "orchestrator"
      ? [
          ...READ_ONLY,
          ...(this.board ? BOARD_METHODS : []),
          ...views,
          ...(this.orchestration ? ORCHESTRATION_METHODS.filter((name) => name !== "handoff") : []),
          "operation_status",
        ]
      : [...READ_ONLY, ...views, ...(this.orchestration?.canHandoff?.(actor) ? ["handoff"] : [])];
  }

  /** Every method an agent could be granted; listing one grants nothing. */
  listed(actor: Principal): string[] {
    return actor.role === "cli"
      ? this.capabilities(actor)
      : [
          ...this.capabilities({ ...actor, role: "orchestrator" }).filter(
            (name) => name !== "read_handoff" || actor.role === "orchestrator",
          ),
          ...(this.orchestration?.canHandoff?.(actor) ? ["handoff"] : []),
        ];
  }

  /** Adapters' entry point: orchestration actions are asynchronous, the rest delegate to dispatch. */
  async call(actor: Principal, input: unknown, signal?: AbortSignal): Promise<unknown> {
    this.assertActive(actor);
    const request = object(input);
    const method = request["method"];
    if (typeof method === "string" && BOARD_METHODS.includes(method)) {
      exact(request, ["version", "instanceId", "method", "params"]);
      if (request["version"] !== 1 || request["instanceId"] !== this.instanceId)
        throw new ControlError("invalid_request");
      const authorize = () => {
        this.assertActive(actor);
        if (
          actor.role !== "orchestrator" ||
          actor.parentId !== null ||
          !this.orchestration?.authorizeBoard
        )
          throw new ControlError("forbidden");
        this.orchestration.authorizeBoard(actor);
      };
      authorize();
      if (!this.board) throw new ControlError("unavailable");
      const repository = locationId(actor.repository);
      const params = object(request["params"]);
      if (method === "board_threads") return this.board.threads(params, repository);
      if (method === "board_read") return this.board.read(params, repository);
      const input = method === "board_post" ? boardPost(params) : boardResolve(params);
      const operation = await this.operations.begin(
        actor,
        method === "board_post" ? "board_post" : "board_resolve",
        input.idempotencyKey,
        JSON.stringify(input),
        input.thread ?? null,
      );
      if (!operation.created)
        return this.operations.lookup(actor, { operationId: operation.operationId });
      try {
        authorize();
        const result =
          method === "board_post"
            ? await this.board.append(
                `orchestrator:${repository}`,
                actor.generation,
                input,
                authorize,
              )
            : await this.board.resolve(actor.generation, input, repository, authorize);
        authorize();
        return await this.operations.finish(
          actor,
          operation.operationId,
          "succeeded",
          "completed",
          result.thread,
        );
      } catch (error) {
        authorize();
        const refused =
          error instanceof ControlError &&
          ["not_found", "conflict", "capacity", "invalid_request"].includes(error.code);
        return this.operations.finish(
          actor,
          operation.operationId,
          refused ? "failed" : "indeterminate",
          refused ? "refused" : "uncertain",
        );
      }
    }
    if (typeof method === "string" && PREVIEW_METHODS.includes(method)) {
      exact(request, ["version", "instanceId", "method", "params"]);
      if (request["version"] !== 1 || request["instanceId"] !== this.instanceId)
        throw new ControlError("invalid_request");
      if (actor.role === "cli") throw new ControlError("forbidden");
      if (!this.previews) throw new ControlError("unavailable");
      const result = await this.previews.call(actor, method, request["params"]);
      this.assertActive(actor);
      return result;
    }
    if (actor.role === "orchestrator" && (method === "sessions" || method === "session_state")) {
      const result = object(this.dispatch(actor, input));
      const hosts = (await this.orchestration?.hosts?.()) ?? [];
      this.assertActive(actor);
      return { ...result, hosts };
    }
    if (typeof method !== "string" || !ORCHESTRATION_METHODS.includes(method))
      return this.dispatch(actor, input);
    try {
      exact(request, ["version", "instanceId", "method", "params"]);
      if (request["version"] !== 1 || request["instanceId"] !== this.instanceId)
        throw new ControlError("invalid_request");
      const params = object(request["params"]);
      if (!this.orchestration || (method !== "handoff" && actor.role !== "orchestrator"))
        throw new ControlError(method === "handoff" ? "no_parent" : "forbidden");
      const result = await this.orchestration.call(
        actor,
        method,
        params,
        this.operations,
        () => {
          this.assertActive(actor);
        },
        signal,
      );
      this.assertActive(actor);
      if (method === "tail" || method === "wait_for")
        await this.refused(
          actor,
          method,
          "succeeded",
          typeof params["id"] === "string" ? params["id"] : null,
        );
      return result;
    } catch (error) {
      await this.refused(actor, method, "refused", null);
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    for (const grant of this.grants.values()) {
      clearTimeout(grant.timer);
      clearTimeout(grant.mcpTimer);
      if (grant.principal) this.connectionChanged(grant.principal.terminalId, undefined);
      if (grant.principal) {
        this.operations.revoke(grant.principal);
        this.previews?.revoke(grant.principal);
      }
    }
    this.grants.clear();
    this.orchestration?.childEvents?.publish();
  }
}
