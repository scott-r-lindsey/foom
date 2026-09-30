export type AgentId = "claude" | "codex" | "agy";
export interface AgentInstallation {
  readonly id: AgentId;
  readonly path: string | null;
  readonly version: string | null;
  readonly hooks: boolean;
  readonly reason: string;
}
export interface AgentScan {
  readonly path: string;
  readonly warning: string | null;
  readonly agents: readonly AgentInstallation[];
}
/** Trusted main-process adapters supplied by the hook receiver, never the renderer. */
export interface AgentHooks {
  readonly claudeCommand: string;
  readonly codexCommand: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Called once the launch has a terminal ID, before any hook can matter. */
  bind?(terminalId: string): void;
  dispose(): void;
}
export interface AgentLaunch {
  readonly agent: AgentId;
  readonly repository: string;
  readonly worktree: string;
  readonly cols: number;
  readonly rows: number;
  /** UI must disclose that Foom replaces the user's notifier for this invocation. */
  readonly acknowledgeCodexNotifierReplacement?: boolean;
}
