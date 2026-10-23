import { randomUUID } from "node:crypto";
import type { WorkspaceTerminal } from "../../shared/workspace";
import type { ReviewState } from "../../shared/review";
import type { Operations } from "./operations";
import type { Operation, Principal } from "./types";
import type { OrchestrationHost } from "./orchestration.d";
import type { AuthorizedChild, FinishedChildAuthority } from "./orchestration-automation.d";
import type { ForgeTracking } from "./forge-tracking";
import type { ReviewLoops } from "./review-loops";

/** One-shot, durable closing from settled exit observations; never retries failures. */
export class FinishedChildCloser {
  private closeFinished = true;
  private readonly automation = new Map<string, { actor: Principal; operations: Operations }>();
  private readonly closing = new Set<string>();
  private readonly exitObservations = new Map<string, number>();
  private readonly observationWaits = new Set<() => void>();

  constructor(
    private readonly authority: FinishedChildAuthority,
    private readonly host: Pick<OrchestrationHost, "terminals" | "starting" | "close"> & {
      forge?: Partial<Pick<ForgeTracking, "revision" | "readSettled" | "waitForRead">>;
    },
    private readonly reviews: Pick<
      ReviewLoops,
      "keepsStateAfterClose" | "verdictRecorded" | "unread"
    >,
    private readonly reviewMetadata: (row: WorkspaceTerminal) => ReviewState | undefined,
  ) {}

  observeExit(id: string): void {
    const revision = this.host.forge?.revision?.();
    if (revision !== undefined && !this.exitObservations.has(id))
      this.exitObservations.set(id, revision);
  }

  resumed(id: string): void {
    this.exitObservations.delete(id);
  }
  removed(id: string): void {
    this.closing.delete(id);
    this.exitObservations.delete(id);
    this.automation.delete(id);
  }
  retire(id: string): void {
    this.automation.delete(id);
  }
  dispose(): void {
    this.clearObservationWaits();
  }

  configure(enabled: boolean): void {
    this.closeFinished = enabled;
  }

  /** Only the service binds a live, main-granted parent identity (including restore). */
  bind(actor: Principal, operations: Operations): void {
    if (actor.role === "orchestrator") this.automation.set(actor.terminalId, { actor, operations });
  }

  private finishedChild(owned: AuthorizedChild, id: string): boolean {
    const row = this.host.terminals().find((entry) => entry.id === id);
    const review = row && this.reviewMetadata(row);
    const after = this.exitObservations.get(id);
    return (
      this.closeFinished &&
      owned.active() &&
      owned.exited() &&
      row?.exited === true &&
      row.kind === "agent" &&
      !this.host.starting?.(id) &&
      row.state?.state !== "needs_input" &&
      row.execution?.phase !== "blocked" &&
      (!review || this.reviews.keepsStateAfterClose(id, this.closing)) &&
      (review && review.authorId !== id
        ? this.reviews.verdictRecorded(id)
        : (!review || review.phase === "clean" || review.phase === "escalated") &&
          this.reviews.unread(id) === undefined &&
          after !== undefined &&
          ["MERGED", "CLOSED"].includes(this.finishedPullRequest(row, after)?.state ?? ""))
    );
  }

  private finishedPullRequest(row: WorkspaceTerminal, after: number) {
    const pr = this.host.forge?.readSettled?.(row.repository, row.worktree, after);
    if (!pr) {
      const cancel = this.host.forge?.waitForRead?.(row.repository, row.worktree, after);
      if (cancel) this.observationWaits.add(cancel);
    }
    return pr;
  }

  private clearObservationWaits(): void {
    for (const cancel of this.observationWaits) cancel();
    this.observationWaits.clear();
  }

  /** Existing metadata invalidations only; one close attempt per eligible session. */
  sync(): void {
    // Rebuild interest from live eligibility, retiring revoked/resumed/removed sessions.
    this.clearObservationWaits();
    for (const { parentId, id } of this.authority.children()) {
      const run = parentId === null ? undefined : this.automation.get(parentId);
      if (!run || this.closing.has(id)) continue;
      let owned: AuthorizedChild;
      try {
        owned = this.authority.authorize(run.actor, id);
      } catch {
        continue;
      }
      if (!this.finishedChild(owned, id)) continue;
      this.closing.add(id);
      void this.closeFinishedChild(owned, id, run.actor, run.operations);
    }
  }

  private async closeFinishedChild(
    owned: AuthorizedChild,
    id: string,
    actor: Principal,
    operations: Operations,
  ): Promise<void> {
    let operation: Operation | undefined;
    try {
      operation = await operations.begin(
        actor,
        "close",
        `finished-${randomUUID()}`,
        JSON.stringify([id]),
        id,
      );
      operations.lookup(actor, { operationId: operation.operationId });
      if (!owned.valid() || !this.finishedChild(owned, id)) {
        const record = await operations.finish(
          actor,
          operation.operationId,
          "cancelled",
          "completed",
          id,
        );
        owned.note(record);
        this.closing.delete(id);
        return;
      }
      await this.host.close(id);
      await this.finish(owned, actor, operations, operation, "succeeded", id);
    } catch {
      if (operation)
        await this.finish(owned, actor, operations, operation, "failed", id).catch(() => undefined);
      // Retain the final screen on failure, without a self-sustaining retry loop.
    }
  }

  private async finish(
    owned: AuthorizedChild,
    actor: Principal,
    operations: Operations,
    operation: Operation,
    status: "succeeded" | "failed",
    id: string,
  ): Promise<void> {
    const record = await operations.finish(
      actor,
      operation.operationId,
      status,
      status === "succeeded" ? "completed" : "error",
      id,
    );
    owned.note(record);
  }
}
