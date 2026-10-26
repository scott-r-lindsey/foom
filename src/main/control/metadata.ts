import type { ReviewState } from "../../shared/review";
import type { HandoffMetadata } from "../../shared/handoff";
import { pullRequest } from "./forge";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { WorkspaceTerminal } from "../../shared/workspace";
import { prepareTail } from "../evaluator/terminal-tail";
import { ControlError, exact, identifier } from "../../shared/control-validation";
import type { Principal } from "./types";

export function locationId(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

/** Redact before truncation; metadata is untrusted data, never instructions. */
export function metadataName(name: string): string {
  if (name.length > 4096) return "[redacted]";
  return prepareTail([name])
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .slice(0, 160);
}

export class SessionMetadata {
  constructor(
    private readonly source: () => readonly WorkspaceTerminal[],
    private readonly forge: (row: WorkspaceTerminal) => unknown = () => undefined,
    private readonly handoff: (row: WorkspaceTerminal) => HandoffMetadata | undefined = () =>
      undefined,
    private readonly review: (row: WorkspaceTerminal) => ReviewState | undefined = (row) =>
      row.review,
  ) {}

  read(
    actor: Principal,
    method: "sessions" | "session_state",
    params: Record<string, unknown>,
  ): unknown {
    exact(params, method === "sessions" ? ["cursor", "limit"] : ["id"]);
    const rows = this.source().filter((row) => row.repository === actor.repository);
    if (method === "session_state") {
      const id = identifier(params["id"]);
      const row = rows.find((entry) => entry.id === id);
      if (!row) throw new ControlError("not_found");
      return this.row(row);
    }
    const limit = params["limit"] ?? 100;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ControlError("invalid_request");
    let start = 0;
    if (params["cursor"] !== undefined) {
      const cursor = identifier(params["cursor"]);
      const index = rows.findIndex((row) => row.id === cursor);
      if (index < 0) throw new ControlError("not_found");
      start = index + 1;
    }
    const page = rows.slice(start, start + limit);
    return {
      sessions: page.map((row) => this.row(row)),
      nextCursor: start + limit < rows.length ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** One current workspace projection per wait check, independent of target count. */
  states(actor: Principal, ids: readonly string[]) {
    const rows = new Map(
      this.source()
        .filter((row) => row.repository === actor.repository)
        .map((row) => [row.id, row]),
    );
    return ids.map((id) => {
      const row = rows.get(id);
      if (!row) throw new ControlError("not_found");
      return this.row(row);
    });
  }

  private row(row: WorkspaceTerminal) {
    const handoff = this.handoff(row);
    const review = this.review(row);
    const pr = pullRequest(this.forge(row));
    const execution = row.execution;
    const fresh =
      (row.state?.outputRevision ?? 0) === (row.outputRevision ?? 0) &&
      (row.state?.inputRevision ?? 0) === (row.inputRevision ?? 0);
    const current =
      fresh &&
      (!execution ||
        (row.state?.execution?.launch === execution.launch &&
          row.state.execution.revision === execution.revision));
    let state = current ? (row.state?.state ?? "quiet_ok") : "quiet_ok";
    if (execution?.phase === "working") state = "working";
    else if (execution?.phase === "blocked" && !current) state = "needs_input";
    else if (
      (execution?.phase === "starting" || execution?.phase === "idle") &&
      state === "working"
    )
      state = "quiet_ok";
    const reported = row.exited ? "exited" : state;
    return {
      ...(handoff === undefined ? {} : { handoff }),
      ...(pr === undefined ? {} : { pullRequest: pr }),
      ...(review ? { review } : {}),
      id: row.id,
      agent: row.agent,
      ...(row.selection ? { selection: row.selection } : {}),
      repository: locationId(row.repository),
      worktree: locationId(row.worktree),
      name: metadataName(row.branch ?? basename(row.worktree)),
      state: reported,
      reason:
        reported === "needs_input" && current && row.state?.attentionKind === "provider"
          ? "provider_unavailable"
          : reported,
      revision: createHash("sha256")
        .update(
          JSON.stringify([
            pr ?? null,
            review ?? null,
            handoff ?? null,
            row.launchVersion ?? 0,
            execution?.launch ?? 0,
            execution?.revision ?? 0,
            row.state?.timestamp ?? 0,
            reported,
            row.outputRevision ?? 0,
            row.inputRevision ?? 0,
          ]),
        )
        .digest("hex"),
      attentionKind:
        reported === "needs_input"
          ? current
            ? (row.state?.attentionKind ?? "unknown")
            : "unknown"
          : null,
      verdictId: current ? (row.state?.verdictId ?? null) : null,
      untrusted: true,
    };
  }
}
