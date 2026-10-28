import type { AgentManifestV2, ManifestChannel } from "../../../shared/agent-manifest-v2";
import { reduceV2, type V2HookState } from "../../../shared/agent-hook-events";
import type { HookAgent, HookSignal } from "../../../shared/hooks";
import type { ProbeHookObserver } from "../probe-events";
export type HookSession = {
  observe?: ProbeHookObserver | undefined;
  terminalId: string;
  agent: HookAgent;
  digest: Buffer;
  model?: AgentManifestV2;
  channels?: Map<string, ManifestChannel>;
  v2State?: V2HookState;
};
export function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
}

export function reduceEvent(
  session: HookSession,
  value: unknown,
  event?: string | string[],
  sequenceHeader?: string | string[],
  channelHeader?: string | string[],
): HookSignal | undefined {
  if (session.channels) {
    const channel =
      typeof channelHeader === "string"
        ? session.channels.get(channelHeader)
        : channelHeader === undefined
          ? [...session.channels.values()].find((entry) => entry.observer.protocol === "ordered-v2")
          : undefined;
    if (!channel || !session.v2State) throw new Error("Invalid channel");
    return reduceV2(
      channel,
      session.v2State,
      session.terminalId,
      session.agent,
      value,
      event,
      sequenceHeader,
    );
  }
  // Compatibility for main-owned callers using the old single-channel registration API.
  const channel =
    session.model?.hooks?.channels.length === 1 ? session.model.hooks.channels[0] : undefined;
  if (channel) {
    session.v2State ??= {};
    const reduced = reduceV2(
      channel,
      session.v2State,
      session.terminalId,
      session.agent,
      value,
      event,
      sequenceHeader,
    );
    return reduced;
  }
  throw new Error("Unknown hook mapping");
}
