import type { V2Binding } from "./v2-hooks";
import type { AgentSetupStatus } from "./agent-setup";
import type { EnvironmentVariable } from "./environment";
import type { AgyPluginStatus } from "./agy-plugin";
export type HookHealthState = "not-reviewed" | "trusted" | "declined" | "outdated";
export type BuiltinAgentId = "claude" | "codex" | "agy";
export type AgentId = string;
export type AgentValues<T> = Readonly<Record<BuiltinAgentId, T> & Record<string, T>>;
export interface AgentInstallation {
  readonly id: AgentId;
  readonly name?: string;
  readonly mark?: string;
  readonly command?: string;
  readonly path: string | null;
  readonly version: string | null;
  readonly hooks: boolean;
  readonly attentionSignal?: boolean;
  readonly resume?: boolean;
  readonly resumePaste?: readonly { command: string; selector: string }[];
  readonly restoreControl?: boolean;
  readonly source?: string;
  readonly bypassArguments?: readonly string[];
  readonly setup?: AgentSetupStatus;
  readonly agyPlugin?: AgyPluginStatus;
  readonly inline?: boolean;
  readonly cliGuidance?: boolean;
  readonly mcp?: boolean;
  readonly mcpReason?: string;
  readonly healthSupported?: boolean;
  readonly notifierReplacement?: boolean;
  readonly healthInstructions?: string;
  readonly hookState?: HookHealthState;
  readonly reason: string;
}
export interface AgentScan {
  readonly path: string;
  readonly warning: string | null;
  readonly agents: readonly AgentInstallation[];
}
/** Trusted main-process adapters supplied by the hook receiver, never the renderer. */
export interface AgentHooks {
  readonly v2?: V2Binding;
  readonly observerCommand: string;
  readonly observerArgv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Called once the launch has a terminal ID, before any hook can matter. */
  bind?(terminalId: string): void;
  dispose(): void;
}
export interface AgentLaunch {
  readonly terminalId?: string;
  readonly conversationId?: string;
  /** Main-only strict identity for pasted or explicitly assigned conversations. */
  readonly pinConversation?: boolean;
  /** Validated defaults from main settings, never copied from a renderer launch request. */
  readonly defaultArguments?: readonly string[];
  /** Main-only authorization; never copied from renderer payloads. */
  readonly mainCheckout?: boolean;
  /** Main-only identity of an explicitly selected existing checkout. */
  readonly checkoutIdentity?: string;
  readonly sharedCheckout?: boolean;
  /**
   * Main-only: a Foom config session. `worktree` is the config folder, no worktree or
   * control grant is involved, and this bundled CLI directory is prepended to PATH.
   */
  readonly configCli?: string;
  /** Main-only probe capability for this config launch. Never repository control. */
  readonly configEnvironment?: Readonly<Record<string, string>>;
  readonly agent: AgentId;
  readonly repository: string;
  readonly worktree: string;
  readonly cols: number;
  readonly rows: number;
  /**
   * Main-only control role: the repository panel's orchestrator, or an orchestrator's
   * child (an ordinary agent naming its parent). Never copied from IPC or the control API.
   */
  readonly control?: { readonly role: "orchestrator" } | { readonly parentId: string };
  /** Main-validated initial prompt for an orchestrator's child, passed as one argv entry. */
  readonly prompt?: string;
  /** Main-only Environment layers (All sessions, then this agent's); never from IPC. */
  readonly environment?: readonly (readonly EnvironmentVariable[])[];
}
export interface AgentLaunched {
  readonly conversationId?: string;
  readonly bypass?: boolean;
  readonly providerOrigin?: "config" | "bundled";
  readonly id: string;
  readonly attention: "hooks" | "evaluator";
  /** Names of the variables Foom set from Environment settings; never values. */
  readonly environment?: readonly string[];
}
