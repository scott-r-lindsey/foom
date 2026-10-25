import { randomUUID } from "node:crypto";
import { ControlError } from "../../shared/control-validation";
import type { Operations } from "./operations";
import type { Operation, Principal } from "./types";
import type { OrchestrationHost } from "./orchestration.d";
import type { AuthorizedChild, ReviewAuthority } from "./orchestration-automation.d";
import type { ReviewLoops } from "./review-loops";
import type { ReviewSnapshot } from "./review-loops.d";

/** Durable review effects; ReviewLoops alone owns phases and evidence decisions. */
export class ReviewEffects {
  private readonly runs = new Map<string, { actor: Principal; operations: Operations }>();

  constructor(
    private readonly authority: ReviewAuthority,
    private readonly host: Pick<
      OrchestrationHost,
      | "reviewSnapshot"
      | "stop"
      | "launch"
      | "terminals"
      | "bypassDefaults"
      | "saveHandoffs"
      | "place"
    >,
    private readonly reviews: () => Pick<ReviewLoops, "view" | "reviewReady" | "attach" | "stop">,
  ) {}

  bind(id: string, actor: Principal, operations: Operations): void {
    this.runs.set(id, { actor, operations });
  }

  removed(id: string): void {
    this.runs.delete(id);
  }

  dispose(): void {
    for (const id of this.runs.keys()) this.reviews().stop(id);
  }

  async snapshot(id: string): Promise<ReviewSnapshot> {
    const run = this.runs.get(id);
    if (!run) throw new ControlError("forbidden");
    const owned = this.authority.authorize(run.actor, id);
    if (!owned.tree || !this.host.reviewSnapshot) throw new ControlError("unavailable");
    return this.host.reviewSnapshot(owned.repository, owned.tree.path, owned.tree.identity);
  }

  async stop(
    id: string,
    validate: (snapshot: ReviewSnapshot) => boolean,
  ): Promise<"stopped" | "changed" | "exited"> {
    const state = this.reviews().view(id);
    const run = state && this.runs.get(state.authorId);
    if (!run) throw new ControlError("forbidden");
    const { actor, operations } = run;
    const owned = this.authority.authorize(actor, id);
    const operation = await operations.begin(
      actor,
      "stop",
      `review-stop-${randomUUID()}`,
      JSON.stringify([id]),
      id,
    );
    try {
      const snapshot = await this.snapshot(state.authorId);
      operations.lookup(actor, { operationId: operation.operationId });
      owned.validate();
      const current = this.reviews().view(id);
      if (current?.phase !== state.phase || current.round !== state.round)
        throw new ControlError("conflict");
      if (!validate(snapshot)) {
        const record = await operations.finish(
          actor,
          operation.operationId,
          "cancelled",
          "completed",
          id,
        );
        owned.note(record);
        return "changed";
      }
      // Unlike a human/parent stop, this validated completion preserves the loop.
      const signaled = await this.host.stop(id);
      await this.finish(owned, actor, operations, operation, "succeeded", id);
      return signaled ? "stopped" : "exited";
    } catch (error) {
      await this.finish(owned, actor, operations, operation, "indeterminate").catch(
        () => undefined,
      );
      throw error;
    }
  }

  async step(authorId: string, reviewer: boolean, prompt: string): Promise<string | undefined> {
    const run = this.runs.get(authorId);
    if (!run) throw new ControlError("forbidden");
    const { actor, operations } = run;
    const owned = this.authority.authorize(actor, authorId);
    const tree = owned.tree;
    const state = this.reviews().view(authorId);
    const author = this.host.terminals().find((row) => row.id === authorId);
    if (!tree || !author || !state) throw new ControlError("not_found");
    if (!this.authority.capacity(actor)) return undefined;
    const agent = reviewer ? state.agent : author.agent;
    let operation: Operation | undefined;
    const validate = () => {
      if (operation) operations.lookup(actor, { operationId: operation.operationId });
      owned.validate();
      if (reviewer && !this.reviews().reviewReady(authorId)) throw new ControlError("conflict");
      const current = this.reviews().view(authorId);
      if (
        current?.phase !== state.phase ||
        current.round !== state.round ||
        this.host.bypassDefaults?.(agent) ||
        this.host
          .terminals()
          .some(
            (row) =>
              row.worktree === tree.path &&
              !row.exited &&
              !(row.id === authorId && row.dormant && !reviewer),
          )
      )
        throw new ControlError("conflict");
    };
    validate();
    const reservation = this.authority.reserve(actor, authorId);
    if (!reservation) return undefined;
    try {
      operation = await operations.begin(
        actor,
        "launch",
        `review-${randomUUID()}`,
        JSON.stringify([authorId, state.round, reviewer]),
        authorId,
      );
      await this.host.saveHandoffs?.();
      validate();
      const resume = reviewer
        ? undefined
        : { id: authorId, conversationId: author.conversationId ?? "" };
      if (!reviewer) {
        reservation.exited(false);
        this.authority.resumed(authorId);
      }
      const id = await this.host.launch(
        actor.terminalId,
        owned.repository,
        tree.path,
        tree.identity,
        agent,
        prompt,
        { ...(resume ? { resume } : {}), loop: state, validate },
      );
      reservation.attach(id, reviewer);
      this.reviews().attach(id, authorId);
      const current = this.reviews().view(authorId);
      const cancelled =
        !owned.active() || current?.phase !== state.phase || current.round !== state.round;
      if (cancelled) await this.host.stop(id);
      this.authority.changed();
      if (reviewer && !cancelled) this.host.place?.(id, actor.terminalId);
      await this.finish(owned, actor, operations, operation, "succeeded", id);
      return id;
    } catch (error) {
      if (!reviewer) reservation.exited(true);
      if (operation)
        await this.finish(owned, actor, operations, operation, "indeterminate").catch(
          () => undefined,
        );
      throw error;
    } finally {
      reservation.release();
      this.authority.released();
    }
  }

  private async finish(
    owned: AuthorizedChild,
    actor: Principal,
    operations: Operations,
    operation: Operation,
    status: "succeeded" | "indeterminate",
    resultId: string | null = null,
  ): Promise<void> {
    const record = await operations.finish(
      actor,
      operation.operationId,
      status,
      status === "succeeded" ? "completed" : "uncertain",
      resultId,
    );
    owned.note(record);
  }
}
