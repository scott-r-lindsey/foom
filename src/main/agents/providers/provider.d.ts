import type { AgentManifestV2 } from "../../../shared/agent-manifest-v2";
import type { McpAttachment } from "../../control/types";
import type { AgentHooks, AgentId, AgentInstallation, AgentLaunch } from "../../../shared/agents";
export interface PreparedLaunch {
  args: string[];
  environment?: readonly { name: string; value: string }[];
  mcp: boolean;
  /** Selected attachment only, for isolated protocol probes using the real launch engine. */
  mcpArguments?: readonly string[];
  conversationId?: string;
  dispose(): void;
}
export interface AgentProvider {
  readonly origin?: "bundled" | "config";
  readonly model: AgentManifestV2;
  setupFacts?(
    path: string,
    engine: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>>;
  prepareLaunch(
    installation: AgentInstallation,
    request: AgentLaunch,
    defaults: readonly string[],
    control: McpAttachment | undefined,
    config: boolean,
    hooksEnabled: boolean,
    binding?: AgentHooks,
  ): Promise<PreparedLaunch>;
  readonly id: AgentId;
  readonly name: string;
  readonly mark: string;
  validate?(): Promise<void>;
  resume(id: unknown): string[];
  readonly executableNames: readonly string[];
  discover(executable: string, version: string, help: string): AgentInstallation;
  enrich(installation: AgentInstallation, plugin?: unknown): Promise<AgentInstallation>;
  needsNotifier(
    installation: AgentInstallation,
    binding: AgentHooks | undefined,
    healthTrusted?: boolean,
  ): boolean;
}
