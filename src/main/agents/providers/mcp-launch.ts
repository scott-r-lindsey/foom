import { agentProvider } from "./registry";
import { meetsMinimum } from "../version";
import { randomUUID } from "node:crypto";
import type { AgentId } from "../../../shared/agents";

/** The real-client probe establishes a stable release floor, not a release allowlist. */
export function supportsMcp(agent: AgentId, version: string, help: string): boolean {
  const provider = agentProvider(agent);
  if (provider.model) return provider.discover("", version, help).mcp === true;
  return (
    agent === "codex" &&
    meetsMinimum(version, /^codex-cli (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, [0, 161, 0]) &&
    /(?:^|\s)-c(?:[ ,]|$)/mu.test(help)
  );
}

export async function prepareMcpLaunch(
  agent: AgentId,
  endpoint: string,
): Promise<{ args: string[]; dispose(): void }> {
  const provider = agentProvider(agent);
  if (provider.model) return provider.prepareMcp(endpoint);
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/control/v1" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Invalid control endpoint");
  url.pathname = "/mcp";
  const name = `foom_${randomUUID().replaceAll("-", "")}`;
  if (agent === "codex")
    return {
      args: [
        "-c",
        `mcp_servers.${name}={url=${JSON.stringify(url.href)},bearer_token_env_var="FOOM_CONTROL_TOKEN"}`,
      ],
      dispose: () => undefined,
    };
  throw new Error("Per-launch MCP attachment is unsupported");
}
