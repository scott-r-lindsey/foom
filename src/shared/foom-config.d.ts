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
}

/** A change held because it would weaken attention, awaiting Allow or Keep it on. */
export interface ConfigPending {
  /** Follows "An agent wants to", for example "turn off the needs-you sound". */
  action: string;
  file: string;
  detail: string;
}

export interface ConfigStatus {
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

export interface ConfigApi {
  configStatus(): Promise<ConfigStatus>;
  /** Allow applies and commits the held change; keep restores the last applied file. */
  decideConfig(decision: "allow" | "keep"): Promise<ConfigStatus>;
  revertConfig(commit: string): Promise<ConfigStatus>;
  openConfigFolder(): Promise<void>;
  onConfigChange(callback: (status: ConfigStatus) => void): () => void;
}
