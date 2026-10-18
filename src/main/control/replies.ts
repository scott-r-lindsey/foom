import type { HandoffMetadata } from "../../shared/handoff";
import type { DialogContent } from "../../shared/confirmation";
import type { WorkspaceTerminal } from "../../shared/workspace";
import { prepareTail } from "../evaluator/terminal-tail";
import { metadataName, SessionMetadata } from "./metadata";
import type { Operations } from "./operations";
import type { Operation, Principal } from "./types";
import { ControlError, exact, identifier, object } from "../../node-common/control-validation";

export interface ReplyHost {
  terminals(): readonly WorkspaceTerminal[];
  tail(id: string, lines: number): Promise<string[]>;
  dialog(content: DialogContent, signal: AbortSignal): Promise<boolean>;
  reply?(id: string, data: string): Promise<void>;
  reveal?(id: string): void;
}
interface Budget {
  readonly verdicts: Set<string>;
  sent: number;
  question: string | null;
  suspended: boolean;
  at: number;
}

/** Current PTYs have no atomic question routing. Every delivery is a human action. */
export class ReviewedReplies {
  private readonly pending = new Map<string, Set<AbortController>>();
  private readonly budgets = new Map<string, Budget>();
  private readonly revisions = new Map<string, number>();
  constructor(
    private readonly host: ReplyHost,
    private readonly now: () => number,
    private readonly forge: (row: WorkspaceTerminal) => unknown = () => undefined,
    private readonly handoff: (row: WorkspaceTerminal) => HandoffMetadata | undefined = () =>
      undefined,
  ) {}

  invalidate(id: string): void {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    for (const abort of this.pending.get(id) ?? []) abort.abort();
  }

  forget(id: string): void {
    this.invalidate(id);
    this.revisions.delete(id);
    this.budgets.delete(id);
  }

  reset(id: string): void {
    this.invalidate(id);
    const budget = this.budgets.get(id);
    if (budget) {
      budget.sent = 0;
      budget.question = null;
      budget.suspended = false;
      budget.at = -Infinity;
    }
  }

  async propose(
    actor: Principal,
    params: Record<string, unknown>,
    operations: Operations,
    authorize: () => void,
    note: (operation: Operation) => void,
    parentAborts: Set<AbortController>,
  ): Promise<Operation> {
    exact(params, ["id", "revision", "verdictId", "text", "idempotencyKey"]);
    const id = identifier(params["id"]);
    const revision = identifier(params["revision"]);
    const verdictId = identifier(params["verdictId"]);
    const key = identifier(params["idempotencyKey"]);
    const text = params["text"];
    if (
      typeof text !== "string" ||
      !text.trim() ||
      Buffer.byteLength(text) > 4096 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text) ||
      text.trimStart().startsWith("/")
    )
      throw new ControlError("invalid_request");
    authorize();
    const stamp = this.revisions.get(id) ?? 0;
    const metadata = new SessionMetadata(() => this.host.terminals(), this.forge, this.handoff);
    const terminalMetadata = new SessionMetadata(() => this.host.terminals());
    const terminalRevision = object(terminalMetadata.read(actor, "session_state", { id }))[
      "revision"
    ];
    const check = (initial = false) => {
      authorize();
      const state = object(
        (initial ? metadata : terminalMetadata).read(actor, "session_state", { id }),
      );
      if (
        state["state"] !== "needs_input" ||
        state["attentionKind"] !== "question" ||
        state["revision"] !== (initial ? revision : terminalRevision) ||
        state["verdictId"] !== verdictId ||
        (this.revisions.get(id) ?? 0) !== stamp
      )
        throw new ControlError("conflict");
    };
    let known = false;
    try {
      operations.lookup(actor, { idempotencyKey: key });
      known = true;
    } catch (error) {
      if (!(error instanceof ControlError) || error.code !== "not_found") throw error;
    }
    if (!known) {
      try {
        check(true);
      } catch (error) {
        this.host.reveal?.(id);
        throw error;
      }
    }
    const input = JSON.stringify([id, revision, verdictId, text]);
    const operation = await operations.begin(
      actor,
      "reply",
      key,
      input,
      id,
      true,
      // Store a redacted proposal, never the raw input. Fingerprint above is hashed by Operations.
      prepareTail([text]).slice(0, 4096),
    );
    if (!operation.created) return operation;
    const abort = new AbortController();
    const pending = this.pending.get(id) ?? new Set<AbortController>();
    this.pending.set(id, pending);
    pending.add(abort);
    parentAborts.add(abort);
    const budget = this.budgets.get(id) ?? {
      verdicts: new Set<string>(),
      sent: 0,
      at: -Infinity,
      question: null,
      suspended: false,
    };
    this.budgets.set(id, budget);
    let writing = false;
    const finish = async (status: "succeeded" | "declined" | "cancelled" | "indeterminate") => {
      const result = await operations.finish(
        actor,
        operation.operationId,
        status,
        status === "succeeded" ? "completed" : status === "indeterminate" ? "uncertain" : "refused",
      );
      note(result);
      return result;
    };
    const review = async (): Promise<Operation> => {
      try {
        check();
        if (
          !this.host.reply ||
          budget.verdicts.has(verdictId) ||
          budget.suspended ||
          budget.sent >= 3 ||
          this.now() - budget.at < 10_000
        )
          return await finish("cancelled");
        budget.verdicts.add(verdictId);
        note(operation);
        const context = prepareTail(await this.host.tail(id, 12)).slice(-8192);
        check();
        const question =
          context
            .split("\n")
            .findLast((line) => line.trim().length > 0)
            ?.trim() ?? "";
        if (budget.question === question) {
          budget.suspended = true;
          return await finish("cancelled");
        }
        const accepted = await this.host.dialog(
          {
            title: `Reply to ${metadataName(this.host.terminals().find((row) => row.id === id)?.branch ?? id)}?`,
            accept: "Send reply",
            detail:
              "The orchestrator proposes this text. Review the current child terminal before sending. A PTY can change its input mode without output; approval is your action. Unattended replies are disabled.",
            reply: { context, text },
          },
          abort.signal,
        );
        check();
        if (!accepted) return await finish("declined");
        if (budget.sent >= 3 || this.now() - budget.at < 10_000) return await finish("cancelled");
        // Persist and recheck before a single write. Never retry even an ambiguous failure.
        await operations.finish(actor, operation.operationId, "running", "intent");
        check();
        budget.question = question;
        budget.sent++;
        budget.at = this.now();
        writing = true;
        await this.host.reply(id, `${text}\r`);
        return await finish("succeeded");
      } catch (error) {
        // Revoked principals cannot record a new result; Operations.revoke already reconciles it.
        operations.lookup(actor, { operationId: operation.operationId });
        if (!writing) this.host.reveal?.(id);
        if (error instanceof ControlError && error.code === "unavailable") throw error;
        return await finish(writing ? "indeterminate" : "cancelled");
      } finally {
        pending.delete(abort);
        if (!pending.size) this.pending.delete(id);
        parentAborts.delete(abort);
      }
    };
    void review().catch(() => {
      /* Revocation or audit failure: no delivery/retry. */
    });
    return operation;
  }
}
