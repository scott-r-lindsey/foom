import type { RemovalReason } from "../workspace/worktree-outcome";
export type Role = "agent" | "orchestrator" | "cli";
export interface Principal {
  /** ISO timestamp when the current role was granted; refreshed on role changes. */
  readonly grantedAt: string;
  readonly generation: string;
  readonly sessionId: string;
  readonly repository: string;
  readonly worktree: string;
  readonly terminalId: string;
  readonly parentId: string | null;
  readonly role: Role;
}
/** Provider attachment data alone carries no workspace authority. */
export interface McpAttachment {
  readonly toolNames?: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Idempotent; preparation and the owning service may both revoke on failure. */
  dispose(): void;
}
export interface ControlLaunch extends McpAttachment {
  bind(terminalId: string, mcp?: boolean): void;
}
export type Action =
  | "create_worktree"
  | "launch"
  | "stop"
  | "close"
  | "remove_worktree"
  | "prompt"
  | "send_keys"
  | "reply";
export type Status =
  | "pending_confirmation"
  | "running"
  | "succeeded"
  | "failed"
  | "declined"
  | "cancelled"
  | "indeterminate";
export type Reason =
  | "intent"
  | "completed"
  | "refused"
  | "revoked"
  | "uncertain"
  | "error"
  | RemovalReason;
export interface Operation {
  readonly operationId: string;
  readonly action: Action;
  readonly targetId: string | null;
  readonly resultId: string | null;
  readonly status: Status;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reason: Reason;
  readonly detail?: string;
  readonly proposal?: string;
  readonly inputHash?: string;
}
export interface StoredOperation {
  readonly actor: Principal;
  readonly key: string;
  readonly fingerprint: string;
  readonly operation: Operation;
}

export interface PairingOptions {
  repository(path: string): string | undefined;
  approve(
    repository: string,
    code: string,
    signal: AbortSignal,
    expiresAt: number,
  ): Promise<boolean>;
}
