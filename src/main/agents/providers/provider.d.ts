import type { AgentHooks, AgentId, AgentInstallation, AgentLaunch } from "../../../shared/agents";
import type { AgyPlugin } from "../agy-plugin";
import type { prepareMcpLaunch } from "../mcp-launch";
export interface AgentProvider {
  readonly id: AgentId;
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
