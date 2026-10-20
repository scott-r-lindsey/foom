import { observerHealth, installedObserverPath } from "./installed-observers";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HookLaunch } from "../../../shared/hooks";
import { writeOwnedFile, readOwnedFile } from "./v2-files";
import { V2ExecutionHooks } from "./v2-health";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import type { AgentManifestV2 } from "../../../shared/agent-manifest-v2";
import type { AgentHooks } from "../../../shared/agents";
import type { HookExecutor, HookRegistrar } from "./hook-launch";
import { privateDirectory } from "../../../node-common/private-files";
import { observerAssets, observerInvocation, observerVersion } from "./v2-observers";
import type { V2Binding } from "../../../shared/v2-hooks";

export async function prepareV2Hooks(
  receiver: HookRegistrar,
  model: AgentManifestV2,
  bind: (key: string, terminal: string | undefined) => void,
  windows: boolean,
  scratch: string,
  stableDirectory?: string,
  execute: HookExecutor = promisify(execFile),
  installed = false,
): Promise<AgentHooks & { disposeAndWait(): Promise<void> }> {
  const temporary = await mkdtemp(join(scratch, "foom-v2-hooks-"));
  const cleanupState: { removal?: Promise<void> } = {};
  try {
    const directory = await privateDirectory(temporary);
    const stableRoot = await privateDirectory(
      stableDirectory ?? scratch,
      `foom-observers-${String(userInfo().uid)}`,
    );
    const key = randomUUID();
    const v2: V2Binding = { values: { hookDir: directory }, channels: new Map(), state: {} };
    let launch: HookLaunch | undefined;
    const env: Record<string, string> = {};
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      launch?.revoke();
      bind(key, undefined);
      cleanupState.removal = rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    };
    try {
      for (const channel of model.hooks?.channels ?? []) {
        const options = channel.observer;

        env[`FOOM_CHANNEL_${channel.id.replaceAll("-", "_")}`] = channel.id;
        if (options.transport === "external") continue;
        if (options.sequence) {
          const order = join(directory, `${channel.id}.order`);
          await writeOwnedFile(order, "0");
          env[`FOOM_ORDER_${channel.id.replaceAll("-", "_")}`] = order;
          if (options.protocol === "ordered-v2") env["FOOM_HOOK_ORDER"] = order;
        }
        if (options.placement === "plugin") continue;
        const packaged = installed && options.placement === "stable";
        const assets = packaged ? {} : observerAssets(channel, windows);
        if (options.placement === "stable" && assets["observer.ps1"])
          assets["observer.ps1"] = assets["observer.ps1"].replace(
            "\\send.ps1",
            `\\${options.basename}-v${String(observerVersion(channel, windows))}-send.ps1`,
          );
        const root =
          options.placement === "stable"
            ? await privateDirectory(await privateDirectory(stableRoot, model.id), channel.id)
            : await privateDirectory(directory, channel.id);
        const version = observerVersion(channel, windows);
        v2.values[`observerVersion:${channel.id}`] = version;
        const basename = `${options.basename}-v${String(version)}`;
        let script = packaged ? installedObserverPath(channel, windows) : "";
        for (const [name, content] of Object.entries(assets)) {
          const target = join(
            root,
            options.placement === "stable"
              ? name.startsWith("observer.")
                ? `${basename}.${windows ? "ps1" : "sh"}`
                : `${basename}-${name}`
              : name,
          );
          if (options.placement === "stable") {
            try {
              await writeOwnedFile(target, content);
            } catch (error) {
              if ((await readOwnedFile(target, 65536)) !== content) throw error;
            }
          } else await writeOwnedFile(target, content);
          if (name.startsWith("observer.")) script = target;
        }
        const add = (event?: string) => {
          const suffix = event ? `.${event}` : "";
          const invocation = observerInvocation(
            script,
            [...options.commandArguments, ...(event ? [event] : [])],
            windows,
            options.placement === "stable",
          );
          v2.values[`observerCommand:${channel.id}${suffix}`] = invocation.command;
          v2.values[`observerArgv:${channel.id}${suffix}`] = invocation.argv;
        };
        if (windows && options.placement === "launch") {
          try {
            await execute(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                script,
                "--foom-probe",
              ],
              { timeout: 8000, maxBuffer: 65536 },
            );
          } catch {
            throw new Error(
              "PowerShell hook script could not run. Check enforced script policy or disable hooks.",
            );
          }
        }
        add();
        for (const event of new Set(channel.mapping.cases.map((entry) => entry.event))) {
          if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(event)) add(event);
        }
      }
      launch = receiver.register(key, model.id, { channels: v2.channels, state: v2.state });
      Object.assign(env, launch.env);
      env["FOOM_HOOK_PROTOCOL"] = "1";
      const health = await observerHealth(model, stableDirectory ?? scratch, installed, windows);
      v2.runtime = new V2ExecutionHooks(model, v2.channels, health);
      return {
        observerCommand: "",
        observerArgv: [],
        get env() {
          return {
            ...env,
            FOOM_HOOK_CHANNELS: JSON.stringify(
              [...v2.channels.values()]
                .filter((channel) => channel.observer.transport === "external")
                .map((channel) => channel.id),
            ),
          };
        },
        v2,
        bind: (terminal) => {
          if (!disposed) bind(key, terminal);
        },
        dispose,
        disposeAndWait: async () => {
          dispose();
          await cleanupState.removal;
        },
      };
    } catch (error) {
      dispose();
      throw error;
    }
  } catch (error) {
    await (cleanupState.removal ?? rm(temporary, { recursive: true, force: true }));
    throw error;
  }
}
