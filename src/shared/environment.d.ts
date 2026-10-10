import type { AgentId } from "./agents";

/** All sessions, or one agent. Shells get "all" only; agents get "all" then their own. */
export type EnvironmentScope = "all" | AgentId;

/** One validated variable, as main applies it at launch. Main-only: values may be secret. */
export interface EnvironmentVariable {
  readonly name: string;
  readonly value: string;
}

/** A row as the renderer sees it. A saved secret's value is never sent: it is null. */
export interface EnvironmentRow {
  readonly name: string;
  readonly value: string | null;
  readonly secret: boolean;
}

export interface EnvironmentState {
  readonly lists: Readonly<Record<EnvironmentScope, readonly EnvironmentRow[]>>;
  /** Names compare case-insensitively and PATH uses `;` with drive-letter directories. */
  readonly windows: boolean;
  /** Secrets need OS-backed `safeStorage`; without it, secret rows are refused. */
  readonly secrets: boolean;
}

/**
 * Adds a row (`previous` null) or replaces the row named `previous`. A null value keeps
 * a saved secret's value, so a secret can be renamed without the renderer reading it.
 */
export interface EnvironmentChange {
  readonly scope: EnvironmentScope;
  readonly previous: string | null;
  readonly name: string;
  readonly value: string | null;
  readonly secret: boolean;
}

/** A proxy or certificate variable from the login shell. Credentials in a URL are masked. */
export interface EnvironmentCandidate {
  readonly name: string;
  readonly display: string;
  /** Compared with the All sessions list. */
  readonly status: "new" | "same" | "replaces";
}

export interface EnvironmentApi {
  environmentState(): Promise<EnvironmentState>;
  saveEnvironment(change: EnvironmentChange): Promise<EnvironmentState>;
  removeEnvironment(scope: EnvironmentScope, name: string): Promise<EnvironmentState>;
  /** One-time read of the login shell; nothing is added until `importEnvironment`. */
  readShellEnvironment(): Promise<readonly EnvironmentCandidate[]>;
  /** Adds the picked names from the last read to All sessions. */
  importEnvironment(names: readonly string[]): Promise<EnvironmentState>;
}
