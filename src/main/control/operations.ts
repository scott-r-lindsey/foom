import { createHash, randomUUID } from "node:crypto";
import { ControlError, exact, identifier } from "./validation";
import type { Action, Operation, Principal, Reason, Status, StoredOperation } from "./types";

const actions: readonly string[] = [
  "create_worktree",
  "launch",
  "stop",
  "remove_worktree",
  "reply",
];
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Separate from rotated audit history: never evict live grant deduplication records. */
export class Operations {
  private readonly records = new Map<string, StoredOperation>();
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly persist: (record: StoredOperation) => Promise<void>,
    private readonly active: (actor: Principal) => void,
    private readonly limit = 4096,
  ) {}

  private check(actor: Principal): void {
    this.active(actor);
    if (actor.role !== "orchestrator") throw new ControlError("forbidden");
  }

  lookup(actor: Principal, selector: Record<string, unknown>): Operation {
    this.check(actor);
    exact(selector, ["operationId", "idempotencyKey"]);
    if ((selector["operationId"] === undefined) === (selector["idempotencyKey"] === undefined))
      throw new ControlError("invalid_request");
    const value = identifier(selector["operationId"] ?? selector["idempotencyKey"]);
    const found = [...this.records.values()].find(
      (record) =>
        record.actor.generation === actor.generation &&
        record.actor.repository === actor.repository &&
        (selector["operationId"] !== undefined
          ? record.operation.operationId === value
          : record.key === hash(value)),
    );
    if (!found) throw new ControlError("not_found");
    return { ...found.operation };
  }

  /** Input is a validated canonical encoding from the future action handler; only its hash persists. */
  async begin(
    actor: Principal,
    action: Action,
    key: string,
    input: string,
    targetId: string | null = null,
    confirmation = false,
  ): Promise<Operation & { readonly created: boolean }> {
    this.check(actor);
    identifier(key);
    if (!actions.includes(action) || typeof input !== "string" || Buffer.byteLength(input) > 65536)
      throw new ControlError("invalid_request");
    if (targetId !== null) identifier(targetId);
    const index = `${actor.generation}:${hash(key)}`;
    const fingerprint = hash(JSON.stringify([action, targetId, confirmation, input]));
    const existing = this.records.get(index);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ControlError("conflict");
      await this.writes;
      this.check(actor);
      return { ...this.lookup(actor, { idempotencyKey: key }), created: false };
    }
    if (this.records.size >= this.limit) throw new ControlError("capacity");
    const now = new Date().toISOString();
    const record: StoredOperation = {
      actor,
      key: hash(key),
      fingerprint,
      operation: {
        operationId: randomUUID(),
        action,
        targetId,
        resultId: null,
        status: confirmation ? "pending_confirmation" : "running",
        createdAt: now,
        updatedAt: now,
        reason: "intent",
      },
    };
    // Reserve before awaiting disk, including failures: never retry an ambiguous intent.
    this.records.set(index, record);
    await this.save(index, record);
    this.check(actor);
    return { ...record.operation, created: true };
  }

  async finish(
    actor: Principal,
    operationId: string,
    status: Exclude<Status, "pending_confirmation">,
    reason: Reason,
    resultId: string | null = null,
  ): Promise<Operation> {
    this.check(actor);
    if (resultId !== null) identifier(resultId);
    const entry = [...this.records.entries()].find(
      ([, record]) => record.actor === actor && record.operation.operationId === operationId,
    );
    if (!entry) throw new ControlError("not_found");
    const [index, prior] = entry;
    if (
      !["running", "pending_confirmation"].includes(prior.operation.status) ||
      !["running", "succeeded", "failed", "declined", "cancelled", "indeterminate"].includes(
        status,
      ) ||
      !["intent", "completed", "refused", "revoked", "uncertain", "error"].includes(reason)
    )
      throw new ControlError("conflict");
    const record = {
      ...prior,
      operation: {
        ...prior.operation,
        status,
        reason,
        resultId,
        updatedAt: new Date().toISOString(),
      },
    };
    this.records.set(index, record);
    await this.save(index, record);
    this.check(actor);
    return { ...record.operation };
  }

  /** Main-only closure: cannot be serialized into an HTTP/renderer approval flag. */
  confirmation(
    actor: Principal,
    operationId: string,
    identity: string,
  ): (currentIdentity: string, accepted: boolean) => Promise<Operation> {
    this.check(actor);
    if (this.lookup(actor, { operationId }).status !== "pending_confirmation")
      throw new ControlError("conflict");
    let consumed = false;
    return async (currentIdentity, accepted) => {
      this.check(actor);
      if (
        consumed ||
        currentIdentity !== identity ||
        this.lookup(actor, { operationId }).status !== "pending_confirmation"
      )
        throw new ControlError("conflict");
      consumed = true;
      return this.finish(
        actor,
        operationId,
        accepted ? "running" : "declined",
        accepted ? "intent" : "refused",
      );
    };
  }

  /** Revocation cancels confirmations; effects already started require reconciliation. */
  revoke(actor: Principal): void {
    for (const [index, prior] of this.records) {
      if (
        prior.actor !== actor ||
        !["running", "pending_confirmation"].includes(prior.operation.status)
      )
        continue;
      const pending = prior.operation.status === "pending_confirmation";
      const operation: Operation = {
        ...prior.operation,
        status: pending ? "cancelled" : "indeterminate",
        reason: pending ? "revoked" : "uncertain",
        updatedAt: new Date().toISOString(),
      };
      const record = { ...prior, operation };
      this.records.set(index, record);
      void this.save(index, record).catch(() => undefined);
    }
  }

  async drain(): Promise<void> {
    await this.writes;
  }

  private async save(index: string, record: StoredOperation): Promise<void> {
    const write = this.writes.then(() => this.persist(record));
    this.writes = write.catch(() => undefined);
    try {
      await write;
    } catch {
      this.records.set(index, {
        ...record,
        operation: { ...record.operation, status: "indeterminate", reason: "uncertain" },
      });
      throw new ControlError("unavailable");
    }
  }
}
