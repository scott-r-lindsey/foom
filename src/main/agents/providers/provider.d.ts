import type { AgentPluginManifest } from "../../../shared/agent-plugin";
import type { AgentHooks, AgentId, AgentInstallation, AgentLaunch } from "../../../shared/agents";
import type { AgyPlugin } from "../agy-plugin";
import type { prepareMcpLaunch } from "../mcp-launch";
export interface AgentProvider {
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
