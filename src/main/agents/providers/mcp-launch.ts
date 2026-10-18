import { agentProvider } from "./registry";
import type { AgentId } from "../../../shared/agents";

/** The real-client probe establishes a stable release floor, not a release allowlist. */
export function supportsMcp(agent: AgentId, version: string, help: string): boolean {
  const provider = agentProvider(agent);
  return provider.discover("", version, help).mcp === true;
}

export async function prepareMcpLaunch(
  agent: AgentId,
  endpoint: string,
): Promise<{ args: string[]; dispose(): void }> {
  const provider = agentProvider(agent);
  return provider.prepareMcp(endpoint);
}
