import type { AgentManifestV2 } from "../../../shared/agent-manifest-v2";
import type { ControlLaunch } from "../../control/types";
import type { AgentPluginManifest } from "../../../shared/agent-plugin";
import type { AgentHooks, AgentId, AgentInstallation, AgentLaunch } from "../../../shared/agents";
import type { AgyPlugin } from "../agy-plugin";
import type { prepareMcpLaunch } from "../mcp-launch";
export interface PreparedLaunch {
  args: string[];
  mcp: boolean;
  conversationId?: string;
  dispose(): void;
}
export interface AgentProvider {
  readonly model?: AgentManifestV2;
  setupFacts?(
    path: string,
    engine: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>>;
  prepareLaunch?(
    installation: AgentInstallation,
    request: AgentLaunch,
    defaults: readonly string[],
    control: ControlLaunch | undefined,
    config: boolean,
    hooksEnabled: boolean,
  ): Promise<PreparedLaunch>;
  readonly id: AgentId;
  readonly name: string;
  readonly mark: string;
  readonly manifest?: AgentPluginManifest;
  validate?(): Promise<void>;
  resume(id: unknown): string[];
  prepareMcp(endpoint: string): ReturnType<typeof prepareMcpLaunch>;
  readonly executableNames: readonly string[];
  discover(executable: string, version: string, help: string): AgentInstallation;
  enrich(installation: AgentInstallation, plugin: AgyPlugin): Promise<AgentInstallation>;
  needsNotifier(installation: AgentInstallation, binding: AgentHooks | undefined): boolean;
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
