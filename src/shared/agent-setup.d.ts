export type AgentSetupState =
  | "not-installed"
  | "installed"
  | "outdated"
  | "disabled"
  | "unavailable";
/** Validated presentation only; no metadata, argv, consent or arbitrary file access. */
export interface AgentSetupStatus {
  state: AgentSetupState;
  offer?: string;
  actions: readonly { id: string; label: string }[];
}
