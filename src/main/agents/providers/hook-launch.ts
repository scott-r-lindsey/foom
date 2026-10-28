import { prepareV2Hooks } from "./v2-hook-launch";
import type { ManifestChannel } from "../../../shared/agent-manifest-v2";
import type { V2HookState } from "../../../shared/agent-hook-events";
import { agentProvider } from "./registry";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { AgentHooks } from "../../../shared/agents";
import type { HookAgent, HookLaunch } from "../../../shared/hooks";

export type HookExecutor = (
  command: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<unknown>;

export interface HookRegistrar {
  register(
    key: string,
    agent: HookAgent,
    v2?: { channels: Map<string, ManifestChannel>; state: V2HookState },
  ): HookLaunch;
}

/**
 * Writes this launch's observer script to a private directory and registers credentials
 * under a random key. `bind` maps the key to the terminal once it exists; `dispose`
 * revokes the credentials and deletes the directory.
 */
export async function prepareHookLaunch(
  receiver: HookRegistrar,
  agent: HookAgent,
  bind: (key: string, terminalId: string | undefined) => void,
  platform: NodeJS.Platform = process.platform,
  scratch = tmpdir(),
  execute: HookExecutor = promisify(execFile),
  stableDirectory?: string,
): Promise<AgentHooks> {
  const windows = platform === "win32";
  const provider = agentProvider(agent);
  const model = provider.model;
  return prepareV2Hooks(
    receiver,
    model,
    bind,
    windows,
    scratch,
    stableDirectory,
    execute,
    provider.origin === "bundled",
  );
}
