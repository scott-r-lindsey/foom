import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import { ControlError, exact, identifier, object } from "./validation";
import type { ControlLaunch, Principal, Role } from "./types";
import type { Operations } from "./operations";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Main owns roles and scope. Adapters can only authenticate and dispatch validated requests. */
export class ControlService {
  readonly instanceId = randomUUID();
  private readonly grants = new Map<
    string,
    { digest: Buffer; principal: Principal | null; calls: number }
  >();
  private readonly unknown = digest(randomBytes(32).toString("hex"));
  private closed = false;
  constructor(readonly operations: Operations) {}

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
      !["agent", "orchestrator"].includes(role)
    )
      throw new ControlError("invalid_request");
    if (parentId !== null) identifier(parentId);
    if (sessionId !== undefined) identifier(sessionId);
    const generation = randomUUID();
    const token = randomBytes(32).toString("hex");
    const grant = { digest: digest(token), principal: null as Principal | null, calls: 0 };
    this.grants.set(generation, grant);
    return {
      env: Object.freeze({
        FOOM_CONTROL_TOKEN: token,
        FOOM_CONTROL_INSTANCE: this.instanceId,
        FOOM_SESSION: sessionId ?? generation,
      }),
      bind: (terminalId) => {
        identifier(terminalId);
        if (this.grants.get(generation) !== grant || grant.principal)
          throw new ControlError("unauthorized");
        grant.principal = Object.freeze({
          generation,
          sessionId: sessionId ?? generation,
          repository,
          worktree,
          role,
          parentId,
          terminalId,
        });
      },
      dispose: () => {
        if (this.grants.get(generation) === grant && grant.principal)
          this.operations.revoke(grant.principal);
        this.grants.delete(generation);
      },
    };
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
    return found;
  }

  assertActive(actor: Principal): void {
    if (this.grants.get(actor.generation)?.principal !== actor)
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
    if (grant.calls >= 4) throw new ControlError("capacity");
    grant.calls++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        grant.calls--;
      }
    };
  }

  dispatch(actor: Principal, input: unknown): unknown {
    this.assertActive(actor);
    const request = object(input);
    exact(request, ["version", "instanceId", "method", "params"]);
    if (request["version"] !== 1 || request["instanceId"] !== this.instanceId)
      throw new ControlError("invalid_request");
    const params = object(request["params"]);
    switch (request["method"]) {
      case "whoami":
        exact(params, []);
        return {
          ...actor,
          capabilities: actor.role === "orchestrator" ? ["whoami", "operation_status"] : ["whoami"],
        };
      case "operation_status":
        if (actor.role !== "orchestrator") throw new ControlError("forbidden");
        return this.operations.lookup(actor, params);
      default:
        throw new ControlError("forbidden");
    }
  }

  close(): void {
    this.closed = true;
    for (const grant of this.grants.values())
      if (grant.principal) this.operations.revoke(grant.principal);
    this.grants.clear();
  }
}
