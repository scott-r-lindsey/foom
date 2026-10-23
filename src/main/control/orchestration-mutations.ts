import { reviewOptions } from "../../node-common/review";
import { AUTHOR_REVIEW_BRIEF } from "./review-loops";
import { agentProvider } from "../agents/providers/registry";
import { createHash } from "node:crypto";
import { knownAgentId } from "../agents/providers/registry";
import { ControlError, exact, identifier } from "../../node-common/control-validation";
import { locationId, metadataName } from "./metadata";
import { OrchestrationAuthority, WORKTREE_LIMIT } from "./orchestration-authority";
import type { Operations } from "./operations";
import type { Operation, Principal } from "./types";

const PROMPT_BYTES = 16384;
const REVIEW_PROMPT_BYTES = PROMPT_BYTES - Buffer.byteLength(`${AUTHOR_REVIEW_BRIEF}\n\n`);

/** The checkout may exist although creation reported an error. */
export class UncertainEffect extends Error {}

function text(value: unknown, bytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > bytes ||
    // Prompts may span lines; other control and bidi formatting characters are refused.
    /[^\P{Cc}\n\t]|\p{Cf}/u.test(value) ||
    value.trimStart().startsWith("-")
  )
    throw new ControlError("invalid_request");
  return value;
}

function publicOperation(operation: Operation): Operation {
  const { operationId, action, targetId, resultId, status, createdAt, updatedAt, reason } =
    operation;
  return { operationId, action, targetId, resultId, status, createdAt, updatedAt, reason };
}

/** Worktree and child mutations, with shared authority and operation history. */
export class OrchestrationMutations extends OrchestrationAuthority {
  protected async createWorktree(
    actor: Principal,
    params: Record<string, unknown>,
    operations: Operations,
  ): Promise<Operation> {
    exact(params, ["idempotencyKey", "branch", "pullRequest"]);
    const key = identifier(params["idempotencyKey"]);
    const number = params["pullRequest"];
    if (
      number !== undefined &&
      (params["branch"] !== undefined ||
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        number <= 0)
    )
      throw new ControlError("invalid_request");
    const branch = number === undefined ? text(params["branch"], 200) : `PR #${String(number)}`;
    if (number === undefined && /\s/u.test(branch)) throw new ControlError("invalid_request");
    const operation = await operations.begin(
      actor,
      "create_worktree",
      key,
      JSON.stringify([branch, number ?? null]),
    );
    if (!operation.created) return publicOperation(operation);
    const parent = this.parent(actor);
    const label = metadataName(branch);
    if (number === undefined && this.unused(parent) + parent.creating >= WORKTREE_LIMIT)
      return this.refuse(actor, parent, operations, operation, label, "capacity");
    parent.creating++;
    this.note(parent, this.entry(operation, label));
    try {
      const unused = [...parent.worktrees.values()].filter((tree) => tree.state === "unused");
      const tree =
        number === undefined
          ? await this.host.createWorktree(parent.repository, branch)
          : await (this.host.adoptWorktree?.(parent.repository, number, unused, (path) => {
              this.parent(actor);
              if (path === undefined && this.unused(parent) + parent.creating > WORKTREE_LIMIT)
                throw new ControlError("capacity");
              if (
                unused.some(
                  (tree) =>
                    tree.path === path &&
                    (tree.state !== "unused" || ![...parent.worktrees.values()].includes(tree)),
                )
              )
                throw new ControlError("branch_in_use");
            }) ?? Promise.reject(new ControlError("forge_unavailable")));
      if (number === undefined) this.host.forge?.track({ repository: parent.repository, ...tree });
      else this.host.forge?.track({ repository: parent.repository, ...tree }, number);
      const id = locationId(tree.path);
      parent.worktrees.set(id, {
        path: tree.path,
        branch: tree.branch,
        identity: tree.identity,
        state: "unused",
      });
      return await this.finish(actor, parent, operations, operation, label, "succeeded", id);
    } catch (error) {
      if (error instanceof ControlError)
        return await this.refuse(actor, parent, operations, operation, label, error.code);
      if (error instanceof UncertainEffect) {
        parent.uncertain++;
        return await this.finish(actor, parent, operations, operation, label, "indeterminate");
      }
      return await this.finish(actor, parent, operations, operation, label, "failed");
    } finally {
      parent.creating--;
    }
  }

  protected async launch(
    actor: Principal,
    params: Record<string, unknown>,
    operations: Operations,
  ): Promise<Operation> {
    exact(params, ["idempotencyKey", "worktreeId", "agent", "prompt", "review"]);
    const key = identifier(params["idempotencyKey"]);
    const worktreeId = identifier(params["worktreeId"]);
    const agent = params["agent"];
    if (!knownAgentId(agent)) throw new ControlError("invalid_request");
    const review = params["review"] === undefined ? undefined : reviewOptions(params["review"]);
    if (
      review &&
      (!knownAgentId(review.agent) ||
        !agentProvider(review.agent).model.launch.resume ||
        !agentProvider(agent).model.launch.resume)
    )
      throw new ControlError("invalid_request");
    if (review && this.host.reviewAvailable && !(await this.host.reviewAvailable(review.agent)))
      throw new ControlError("invalid_request");
    const prompt =
      params["prompt"] === undefined
        ? undefined
        : text(params["prompt"], review ? REVIEW_PROMPT_BYTES : PROMPT_BYTES);
    const operation = await operations.begin(
      actor,
      "launch",
      key,
      JSON.stringify([worktreeId, agent, prompt ?? null, review ?? null]),
      worktreeId,
    );
    if (!operation.created) return publicOperation(operation);
    const parent = this.parent(actor);
    const tree = parent.worktrees.get(worktreeId);
    const label = metadataName(tree?.branch ?? worktreeId);
    if (!tree) return this.refuse(actor, parent, operations, operation, label, "not_found");
    // Each child gets a fresh parent-created worktree, used exactly once.
    if (tree.state !== "unused")
      return this.refuse(actor, parent, operations, operation, label, "conflict");
    if (this.running(parent) + parent.starting >= this.childLimit())
      return this.refuse(actor, parent, operations, operation, label, "capacity");
    // Children run with the user's defaults, so bypass defaults refuse before spawning.
    if (this.host.bypassDefaults?.(agent))
      return this.refuse(actor, parent, operations, operation, label, "forbidden");
    // Still charged to the unused budget until the spawn succeeds.
    tree.state = "starting";
    parent.starting++;
    this.note(parent, this.entry(operation, label));
    try {
      const id = await this.host.launch(
        actor.terminalId,
        parent.repository,
        tree.path,
        tree.identity,
        agent,
        review ? `${AUTHOR_REVIEW_BRIEF}\n\n${prompt ?? "Await your assigned task."}` : prompt,
        ...(review
          ? [
              {
                loop: review,
                validate: () => {
                  operations.lookup(actor, { operationId: operation.operationId });
                  this.parent(actor);
                },
              },
            ]
          : []),
      );
      tree.state = "used";
      parent.children.set(id, {
        worktreeId,
        exited: this.early.delete(id),
        takenOver: false,
        tailAt: 0,
      });
      if (review) this.startReview(id, review, actor, operations);
      this.changed();
      this.host.place?.(id, actor.terminalId);
      return await this.finish(actor, parent, operations, operation, label, "succeeded", id);
    } catch (error) {
      if (error instanceof ControlError) throw error;
      tree.state = "unused";
      return await this.finish(actor, parent, operations, operation, label, "failed");
    } finally {
      parent.starting--;
      this.childEvents.publish();
      this.clearEarlyExits();
    }
  }

  protected async close(
    actor: Principal,
    params: Record<string, unknown>,
    operations: Operations,
  ): Promise<Operation> {
    exact(params, ["idempotencyKey", "id"]);
    const key = identifier(params["idempotencyKey"]);
    const id = identifier(params["id"]);
    const operation = await operations.begin(actor, "close", key, JSON.stringify([id]), id);
    if (!operation.created) return publicOperation(operation);
    const parent = this.parent(actor);
    const child = parent.children.get(id);
    const label = child ? this.label(id) : metadataName(id);
    if (!child) return this.refuse(actor, parent, operations, operation, label, "not_found");
    if (child.takenOver)
      return this.refuse(actor, parent, operations, operation, label, "forbidden");
    if (!child.exited) return this.refuse(actor, parent, operations, operation, label, "conflict");
    this.note(parent, this.entry(operation, label));
    try {
      await this.host.close(id);
    } catch {
      return this.finish(actor, parent, operations, operation, label, "failed", id);
    }
    return this.finish(actor, parent, operations, operation, label, "succeeded", id);
  }

  protected async stop(
    actor: Principal,
    params: Record<string, unknown>,
    operations: Operations,
  ): Promise<Operation> {
    exact(params, ["idempotencyKey", "id"]);
    const key = identifier(params["idempotencyKey"]);
    const id = identifier(params["id"]);
    const operation = await operations.begin(actor, "stop", key, JSON.stringify([id]), id);
    if (!operation.created) return publicOperation(operation);
    const parent = this.parent(actor);
    const child = this.own(parent, id);
    const label = child ? this.label(id) : metadataName(id);
    if (!child) return this.refuse(actor, parent, operations, operation, label, "not_found");
    this.reviews.stop(id);
    this.note(parent, this.entry(operation, label));
    if (child.exited)
      return this.finish(actor, parent, operations, operation, label, "succeeded", id);
    if (this.host.starting?.(id))
      return this.refuse(actor, parent, operations, operation, label, "conflict");
    try {
      await this.host.stop(id);
    } catch {
      // The stop may have reached the process; never report a definite failure.
      return this.finish(actor, parent, operations, operation, label, "indeterminate", id);
    }
    return this.finish(actor, parent, operations, operation, label, "succeeded", id);
  }

  protected async removeWorktree(
    actor: Principal,
    params: Record<string, unknown>,
    operations: Operations,
  ): Promise<Operation> {
    exact(params, ["idempotencyKey", "worktreeId"]);
    const key = identifier(params["idempotencyKey"]);
    const worktreeId = identifier(params["worktreeId"]);
    const operation = await operations.begin(
      actor,
      "remove_worktree",
      key,
      JSON.stringify([worktreeId]),
      worktreeId,
      true,
    );
    if (!operation.created) return publicOperation(operation);
    const parent = this.parent(actor);
    const tree = parent.worktrees.get(worktreeId);
    const label = metadataName(tree?.branch ?? worktreeId);
    if (!tree) return this.refuse(actor, parent, operations, operation, label, "not_found");
    if (
      this.host
        .terminals()
        .some(
          (row) =>
            row.repository === parent.repository && row.worktree === tree.path && !row.exited,
        )
    )
      return this.refuse(actor, parent, operations, operation, label, "conflict");
    this.note(parent, this.entry(operation, label));
    const abort = new AbortController();
    parent.aborts.add(abort);
    const outcome = { accepted: false };
    void (async () => {
      try {
        const removed = await this.host.remove(
          parent.repository,
          tree.path,
          tree.identity,
          async (branch, changes, automatic = false) => {
            if (automatic) {
              outcome.accepted = true;
              const record = await operations.finish(
                actor,
                operation.operationId,
                "running",
                "intent",
              );
              this.note(parent, this.entry(record, label));
              return true;
            }
            outcome.accepted = false;
            this.note(
              parent,
              this.entry(await operations.reviewRemoval(actor, operation.operationId), label),
            );
            // Bind the answer to this actor, worktree and the dirty state shown to the human.
            const identity = createHash("sha256")
              .update(JSON.stringify([worktreeId, tree.identity, changes]))
              .digest("hex");
            const answer = operations.confirmation(actor, operation.operationId, identity);
            const pr = this.host.forge?.read(parent.repository, tree.path);
            const answered = await this.host.dialog(
              {
                removal: {
                  group: JSON.stringify([actor.sessionId, actor.generation]),
                  item: {
                    id: operation.operationId,
                    branch: metadataName(branch),
                    path: tree.path,
                    changes,
                    ...(pr ? { pullRequest: { number: pr.number, state: pr.state } } : {}),
                  },
                },
                title: "Remove worktrees?",
                accept: "Approve all",
              },
              abort.signal,
            );
            const approved = answered && !abort.signal.aborted;
            const record = await answer(identity, approved);
            outcome.accepted = approved;
            this.note(parent, this.entry(record, label));
            return approved;
          },
          () => {
            operations.lookup(actor, { operationId: operation.operationId });
            if (abort.signal.aborted) throw new ControlError("forbidden");
          },
        );
        if (removed) {
          parent.worktrees.delete(worktreeId);
          await this.finish(actor, parent, operations, operation, label, "succeeded", worktreeId);
        }
      } catch (error) {
        const record = await this.finish(
          actor,
          parent,
          operations,
          operation,
          label,
          "failed",
        ).catch(() => undefined);
        // Mirror revocation and persistence uncertainty in the visible history.
        if (!record)
          this.note(parent, {
            ...this.entry(operation, label),
            status:
              outcome.accepted || (error instanceof ControlError && error.code === "unavailable")
                ? "indeterminate"
                : "cancelled",
          });
      } finally {
        parent.aborts.delete(abort);
        this.changed();
      }
    })();
    return publicOperation(operation);
  }
}
