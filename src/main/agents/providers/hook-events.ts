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
  sequence?: number;
  completedTurns?: Set<string>;
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
  const lifecycle = session.agent === "codex" && value["hook_event_name"] !== undefined;
  const agentId = lifecycle ? value["session_id"] : value["thread-id"];
  if (!conversationId(agentId) || (session.agentId !== undefined && session.agentId !== agentId))
    throw new Error("Invalid agent session");
  let signal: HookSignal["signal"];
  let action: HookSignal["action"] = "classify";
  if (lifecycle) {
    switch (value["hook_event_name"]) {
      case "SessionStart":
        if (
          typeof value["source"] !== "string" ||
          !["startup", "resume", "clear", "compact"].includes(value["source"])
        )
          throw new Error("Invalid startup source");
        signal = "codex:SessionStart";
        action = "ready";
        break;
      case "UserPromptSubmit":
      case "PreToolUse":
      case "PostToolUse":
        signal = `codex:${value["hook_event_name"]}`;
        action = "working";
        break;
      case "PermissionRequest":
        signal = "codex:PermissionRequest";
        action = "needs_input";
        break;
      case "Stop":
        if (typeof value["stop_hook_active"] !== "boolean") throw new Error("Invalid stop");
        signal = "codex:Stop";
        break;
      default:
        if (typeof value["hook_event_name"] !== "string") throw new Error("Invalid hook");
        return;
    }
    if (action !== "ready" && !identifier(value["turn_id"])) throw new Error("Invalid turn");
    if (
      ["codex:PreToolUse", "codex:PostToolUse", "codex:PermissionRequest"].includes(signal) &&
      (typeof value["tool_name"] !== "string" ||
        value["tool_name"].length === 0 ||
        value["tool_name"].length > 200)
    )
      throw new Error("Invalid tool");
  } else if (session.agent === "codex") {
    if (!identifier(value["turn-id"]) || typeof value["type"] !== "string")
      throw new Error("Invalid turn");
    if (value["type"] !== "agent-turn-complete") return;
    const turn = value["turn-id"];
    session.completedTurns ??= new Set();
    if (session.completedTurns.has(turn)) return;
    session.completedTurns.add(turn);
    if (session.completedTurns.size > 128) {
      const oldest = session.completedTurns.values().next().value;
      if (oldest !== undefined) session.completedTurns.delete(oldest);
    }
    signal = "codex:agent-turn-complete";
  } else throw new Error("Unknown hook mapping");
  session.agentId = agentId;
  return { terminalId: session.terminalId, action, signal, conversationId: agentId };
}
