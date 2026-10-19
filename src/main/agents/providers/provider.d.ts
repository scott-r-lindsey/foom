import type { AgentManifestV2 } from "../../../shared/agent-manifest-v2";
import type { ControlLaunch } from "../../control/types";
import type { AgentHooks, AgentId, AgentInstallation, AgentLaunch } from "../../../shared/agents";
import type { prepareMcpLaunch } from "./mcp-launch";
export interface PreparedLaunch {
  args: string[];
  mcp: boolean;
  /** Selected attachment only, for isolated protocol probes using the real launch engine. */
  mcpArguments?: readonly string[];
  conversationId?: string;
  dispose(): void;
}
export interface AgentProvider {
  readonly legacyChannelConsent?: boolean;
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
    control: ControlLaunch | undefined,
    config: boolean,
    hooksEnabled: boolean,
    binding?: AgentHooks,
  ): Promise<PreparedLaunch>;
  readonly id: AgentId;
  readonly name: string;
  readonly mark: string;
  validate?(): Promise<void>;
  resume(id: unknown): string[];
  prepareMcp(endpoint: string): ReturnType<typeof prepareMcpLaunch>;
  readonly executableNames: readonly string[];
  discover(executable: string, version: string, help: string): AgentInstallation;
  enrich(installation: AgentInstallation, plugin?: unknown): Promise<AgentInstallation>;
  needsNotifier(
    installation: AgentInstallation,
    binding: AgentHooks | undefined,
    healthTrusted?: boolean,
  ): boolean;
  arguments(
    installation: AgentInstallation,
    request: AgentLaunch,
    defaults: readonly string[],
    resume: readonly string[],
    binding: AgentHooks | undefined,
    mcp: Awaited<ReturnType<typeof prepareMcpLaunch>> | undefined,
    control: boolean,
    configSession: boolean,
  ): string[];
}
