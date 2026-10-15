/** One entry in Settings → Foom config → Recent changes. */
export interface ConfigChange {
  id: string;
  time: number;
  summary: string;
  file: string;
  state: "applied" | "rejected" | "pending";
  /** Full commit ID; Revert sends it back and main checks it against this list. */
  commit?: string;
  /** Short commit ID shown beside an applied change. */
  hash?: string;
  /** Fixed reason for a rejected change: a JSON path and reason code, never file text. */
  reason?: string;
  warnings?: number;
}

/** A change held because it would weaken attention, awaiting Allow or Keep it on. */
export interface ConfigPending {
  /** Digest of the held file. A decision names it, so it applies only to what was shown. */
  id: string;
  /** Follows "An agent wants to", for example "turn off the needs-you sound". */
  action: string;
  file: string;
  detail: string;
}

export interface ConfigAgent {
  id: string;
  name: string;
  mark: string;
  command: string;
  file: string;
  state: "pending" | "rejected";
  decisionId?: string;
  reason?: string | undefined;
}
export interface ConfigStatus {
  agentPlugins?: readonly ConfigAgent[];
  folder: string;
  /** False when the folder or git is unusable; settings still apply from the file. */
  available: boolean;
  /** Uncommitted files in Foom's layout, or null when unknown. */
  uncommitted: number | null;
  pending: ConfigPending | null;
  /** Newest first, at most 20. */
  changes: readonly ConfigChange[];
  rejected: number;
  error?: string;
}

export interface ConfigAgentDuplicate {
  id: string;
  status: ConfigStatus;
}

export interface ConfigApi {
  duplicateAgent(id: string): Promise<ConfigAgentDuplicate>;
  configStatus(): Promise<ConfigStatus>;
  /** Allow applies and commits the held change; keep restores the last applied file. */
  decideConfig(decision: "allow" | "keep", id: string): Promise<ConfigStatus>;
  revertConfig(commit: string): Promise<ConfigStatus>;
  openConfigFolder(): Promise<void>;
  onConfigChange(callback: (status: ConfigStatus) => void): () => void;
}
