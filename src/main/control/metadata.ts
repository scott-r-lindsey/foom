import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { WorkspaceTerminal } from "../../shared/workspace";
import { prepareTail } from "../evaluator/inference-input";
import { ControlError, exact, identifier } from "./validation";
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
  constructor(private readonly source: () => readonly WorkspaceTerminal[]) {}

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

  private row(row: WorkspaceTerminal) {
    const execution = row.execution;
    const current =
      !execution ||
      (row.state?.execution?.launch === execution.launch &&
        row.state.execution.revision === execution.revision);
    let state = current ? (row.state?.state ?? "quiet_ok") : "quiet_ok";
    if (execution?.phase === "working") state = "working";
    else if (execution?.phase === "blocked" && !current) state = "needs_input";
    else if (
      (execution?.phase === "starting" || execution?.phase === "idle") &&
      (state === "working" || state === "checking")
    )
      state = "quiet_ok";
    const reported = row.exited ? "exited" : state;
    return {
      id: row.id,
      agent: row.agent,
      repository: locationId(row.repository),
      worktree: locationId(row.worktree),
      name: metadataName(row.branch ?? basename(row.worktree)),
      state: reported,
      reason: reported,
      revision: createHash("sha256")
        .update(
          JSON.stringify([
            row.launchVersion ?? 0,
            execution?.launch ?? 0,
            execution?.revision ?? 0,
            row.state?.timestamp ?? 0,
            reported,
          ]),
        )
        .digest("hex"),
      attentionKind: reported === "needs_input" ? "unknown" : null,
      untrusted: true,
    };
  }
}
