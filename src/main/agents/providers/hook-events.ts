import type { AgentManifestV2, ManifestChannel } from "../../../shared/agent-manifest-v2";
import { reduceV2, type V2HookState } from "./v2-events";
import type { HookMapping } from "../../../shared/agent-plugin";
import { conversationId } from "../conversation";
import type { HookAgent, HookSignal } from "../../../shared/hooks";
export type HookSession = {
  terminalId: string;
  agent: HookAgent;
  digest: Buffer;
  agentId?: string;
  mapping?: HookMapping;
  model?: AgentManifestV2;
  channels?: Map<string, ManifestChannel>;
  v2State?: V2HookState;
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  if (!record(value)) throw new Error("Invalid event");
  if (session.mapping) {
    const mapping = session.mapping;
    const agentId = value[mapping.sessionField];
    if (!conversationId(agentId) || (session.agentId !== undefined && session.agentId !== agentId))
      throw new Error("Invalid agent session");
    const event = value[mapping.eventField];
    if (typeof event !== "string" || event.length > 64) throw new Error("Invalid hook event");
    if (!Object.hasOwn(mapping.events, event)) return;
    const action = mapping.events[event];
    if (!action) return;
    session.agentId = agentId;
    return {
      terminalId: session.terminalId,
      conversationId: agentId,
      action,
      signal: `plugin:${session.agent}:${event}`,
    };
  }
  throw new Error("Unknown hook mapping");
}
