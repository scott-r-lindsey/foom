import { meetsMinimum } from "./version";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicPrivate, privateDirectory } from "../control/private-files";
import type { AgentId } from "../../shared/agents";

/** The real-client probe establishes a stable release floor, not a release allowlist. */
export function supportsMcp(agent: AgentId, version: string, help: string): boolean {
  return (
    (agent === "claude" &&
      meetsMinimum(
        version,
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?: \(Claude Code\))?$/u,
        [2, 1, 293],
      ) &&
      /(?:^|\s)--mcp-config(?:[ =,]|$)/mu.test(help)) ||
    (agent === "codex" &&
      meetsMinimum(version, /^codex-cli (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, [0, 161, 0]) &&
      /(?:^|\s)-c(?:[ ,]|$)/mu.test(help))
  );
}

export async function prepareMcpLaunch(
  agent: AgentId,
  endpoint: string,
): Promise<{ args: string[]; dispose(): void }> {
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
  if (agent !== "claude") throw new Error("Per-launch MCP attachment is unsupported");
  const scratch = await mkdtemp(join(tmpdir(), "foom-mcp-"));
  try {
    const directory = await privateDirectory(scratch);
    await atomicPrivate(directory, "mcp.json", {
      mcpServers: {
        [name]: {
          type: "http",
          url: url.href,
          headers: { Authorization: "Bearer ${FOOM_CONTROL_TOKEN}" },
        },
      },
    });
    return {
      args: ["--mcp-config", join(directory, "mcp.json")],
      dispose: () => {
        void rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}
