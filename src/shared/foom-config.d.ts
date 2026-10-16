/** A config file rejected whole by validation; the previous version stays in effect. */
export interface ConfigRejection {
  file: string;
  /** Fixed reason: a JSON path and reason code, never file text. */
  reason: string;
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
  state: "rejected";
  reason?: string | undefined;
}
export interface ConfigStatus {
  agentPlugins?: readonly ConfigAgent[];
  folder: string;
  /** False when the folder is unusable. */
  available: boolean;
  pending: ConfigPending | null;
  /** Sorted by file. */
  rejected: readonly ConfigRejection[];
  error?: string;
}

export interface ConfigApi {
  configStatus(): Promise<ConfigStatus>;
  /** Allow applies the held change; keep restores the last applied file. */
  decideConfig(decision: "allow" | "keep", id: string): Promise<ConfigStatus>;
  openConfigFolder(): Promise<void>;
  onConfigChange(callback: (status: ConfigStatus) => void): () => void;
}
