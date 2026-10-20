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
export interface ControlLaunch {
  readonly env: Readonly<Record<string, string>>;
  bind(terminalId: string, mcp?: boolean): void;
  /** Idempotent; preparation and the owning service may both revoke on failure. */
  dispose(): void;
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
export type Reason = "intent" | "completed" | "refused" | "revoked" | "uncertain" | "error";
export interface Operation {
  readonly operationId: string;
  readonly action: Action;
  readonly targetId: string | null;
  readonly resultId: string | null;
  readonly status: Status;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reason: Reason;
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
