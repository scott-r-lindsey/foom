import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookAdapter } from "./hook-adapters";
import type { AgentHooks } from "./shared/agents";
import type { HookAgent, HookLaunch } from "./shared/hooks";

export interface HookRegistrar {
  register(key: string, agent: HookAgent): HookLaunch;
}

/** POSIX single-quoting: the path is data to the agent's hook shell, never syntax. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
): Promise<AgentHooks> {
  const windows = platform === "win32";
  const adapter = hookAdapter(agent, windows ? "win32" : "posix");
  // mkdtemp creates the directory with mode 0700, so other users can't swap the script.
  const directory = await mkdtemp(join(scratch, "foom-hooks-"));
  const script = join(directory, `${agent}${adapter.extension}`);
  let launch: HookLaunch | undefined;
  try {
    await writeFile(script, adapter.source, { mode: 0o700, flag: "wx" });
    const key = randomUUID();
    launch = receiver.register(key, agent);
    const argv = windows
      ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-File", script]
      : ["sh", script];
    let disposed = false;
    return {
      // Claude runs hook commands through a shell; Codex receives an argument array.
      claudeCommand: windows
        ? `powershell.exe -NoProfile -NonInteractive -File "${script}"`
        : `sh ${quote(script)}`,
      codexCommand: argv,
      env: launch.env,
      bind: (terminalId) => {
        if (!disposed) bind(key, terminalId);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        launch?.revoke();
        bind(key, undefined);
        void (async () => {
          try {
            await rm(directory, { recursive: true, force: true });
          } catch {
            // Best effort: the script holds no secrets, and the OS clears temp files.
          }
        })();
      },
    };
  } catch (error) {
    launch?.revoke();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
