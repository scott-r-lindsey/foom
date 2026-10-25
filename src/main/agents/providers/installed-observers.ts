import { privateDirectory } from "../../../node-common/private-files";
import { join, sep } from "node:path";
import { tmpdir, userInfo } from "node:os";
import type { AgentManifestV2, ManifestChannel } from "../../../shared/agent-manifest-v2";
import { observerInvocation, observerVersion } from "./v2-observers";
import { expandV2 } from "../../../shared/agent-launch-values";
import { healthStore } from "./v2-health";

/** Build-owned assets live outside ASAR. Config manifests cannot select this root. */
export function installedObserverDirectory(): string {
  return join(__dirname, "../../../observers").replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}
export function installedObserverPath(
  channel: ManifestChannel,
  windows: boolean,
  directory = installedObserverDirectory(),
): string {
  return join(
    directory,
    `${channel.observer.basename}-v${String(observerVersion(channel, windows))}.${windows ? "ps1" : "sh"}`,
  );
}

/** Retain profile observations only when the installed attachment definitions match exactly. */
export async function installedHealth(
  model: AgentManifestV2,
  directory = tmpdir(),
  windows = process.platform === "win32",
  observers = installedObserverDirectory(),
) {
  const channel = model.hooks?.channels.find((entry) => entry.id === model.health?.channel);
  const values: Record<string, string> = {};
  if (channel)
    values[`observerCommand:${channel.id}`] = observerInvocation(
      installedObserverPath(channel, windows, observers),
      channel.observer.commandArguments,
      windows,
      true,
    ).command;
  const definitions = channel?.arguments.map((arg) => expandV2(arg, values)) ?? [];
  const root = await privateDirectory(directory, `foom-observers-${String(userInfo().uid)}`);
  return healthStore(
    root,
    model,
    definitions,
    model.id,
    join(directory, `${model.id}-hook-health.json`),
  );
}

/** The same observed-health policy, with storage and stable paths owned by main. */
export async function observerHealth(
  model: AgentManifestV2,
  directory: string | undefined,
  installed: boolean,
  windows = process.platform === "win32",
) {
  if (installed && model.health) return installedHealth(model, directory, windows);
  const root = await privateDirectory(
    directory ?? tmpdir(),
    `foom-observers-${String(userInfo().uid)}`,
  );
  const values: Record<string, string> = {};
  for (const channel of model.hooks?.channels ?? []) {
    if (channel.observer.placement !== "stable") continue;
    const script = installedObserverPath(channel, windows, join(root, model.id, channel.id));
    const add = (event?: string) => {
      values[`observerCommand:${channel.id}${event ? `.${event}` : ""}`] = observerInvocation(
        script,
        [...channel.observer.commandArguments, ...(event ? [event] : [])],
        windows,
        true,
      ).command;
    };
    add();
    for (const event of new Set(channel.mapping.cases.map((entry) => entry.event)))
      if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(event)) add(event);
  }
  return healthStore(root, model, [model.hooks, model.files, model.health, values]);
}
