/** Credential-free, redacted audit metadata; never terminal output or initial prompts. */
export interface ActionLogEntry {
  path?: string;
  session?: string;
  operationId: string;
  timestamp: string;
  actorId: string;
  parentId: string | null;
  repository: string;
  worktree: string;
  action: string;
  targetId: string | null;
  resultId: string | null;
  status: string;
  reason: string;
  proposal?: string;
  /** SHA-256 of canonical action/input; child input is never retained as text. */
  inputHash?: string;
}
export interface ActionLogQuery {
  search: string;
  action: string;
  status: string;
  offset: number;
}
export interface ActionLogPage {
  entries: readonly ActionLogEntry[];
  total: number;
}
export interface ActionLogApi {
  read(query: ActionLogQuery): Promise<ActionLogPage>;
  clear(): Promise<void>;
}
