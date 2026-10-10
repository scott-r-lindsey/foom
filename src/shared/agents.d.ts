import type { EnvironmentVariable } from "./environment";
import type { AgyPluginStatus } from "./agy-plugin";
export type CodexHookState = "not-reviewed" | "trusted" | "declined" | "outdated";
export type AgentId = "claude" | "codex" | "agy";
export interface AgentInstallation {
  readonly id: AgentId;
  readonly path: string | null;
  readonly version: string | null;
  readonly hooks: boolean;
  readonly agyPlugin?: AgyPluginStatus;
  readonly inline?: boolean;
  readonly cliGuidance?: boolean;
  readonly mcp?: boolean;
  readonly mcpReason?: string;
  readonly codexLifecycle?: boolean;
  readonly codexHookState?: CodexHookState;
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
  readonly codexHookCommand?: string;
  readonly codexNotify?: boolean;
  readonly env: Readonly<Record<string, string>>;
  /** Called once the launch has a terminal ID, before any hook can matter. */
  bind?(terminalId: string): void;
  dispose(): void;
}
export interface AgentLaunch {
  readonly terminalId?: string;
  readonly conversationId?: string;
  /** Validated defaults from main settings, never copied from a renderer launch request. */
  readonly defaultArguments?: readonly string[];
  /** Main-only authorization; never copied from renderer payloads. */
  readonly mainCheckout?: boolean;
  /** Main-only identity of an explicitly selected existing checkout. */
  readonly checkoutIdentity?: string;
  readonly sharedCheckout?: boolean;
  readonly agent: AgentId;
  readonly repository: string;
  readonly worktree: string;
  readonly cols: number;
  readonly rows: number;
  /** UI must disclose that Foom replaces the user's notifier for this invocation. */
  readonly acknowledgeCodexNotifierReplacement?: boolean;
  /** Main-only Environment layers (All sessions, then this agent's); never from IPC. */
  readonly environment?: readonly (readonly EnvironmentVariable[])[];
}
export interface AgentLaunched {
  readonly id: string;
  readonly attention: "hooks" | "evaluator";
  /** Names of the variables Foom set from Environment settings; never values. */
  readonly environment?: readonly string[];
}
