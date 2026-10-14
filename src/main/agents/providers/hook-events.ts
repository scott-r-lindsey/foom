import { conversationId } from "../conversation";
import type { HookAgent, HookSignal } from "../../../shared/hooks";
export type HookSession = {
  terminalId: string;
  agent: HookAgent;
  digest: Buffer;
  agentId?: string;
  sequence?: number;
  completedTurns?: Set<string>;
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
): HookSignal | undefined {
  if (!record(value)) throw new Error("Invalid event");
  if (session.agent === "agy") {
    if (typeof sequenceHeader !== "string" || !/^[1-9][0-9]{0,9}$/.test(sequenceHeader))
      throw new Error("Invalid observer sequence");
    const sequence = Number(sequenceHeader);
    if (sequence > 2147483647) throw new Error("Invalid observer sequence");
    const agentId = value["conversationId"];
    if (!conversationId(agentId) || (session.agentId !== undefined && session.agentId !== agentId))
      throw new Error("Invalid agent session");
    if (event !== "PreInvocation" && event !== "PostToolUse" && event !== "Stop")
      throw new Error("Invalid Antigravity event");
    let terminationReason: HookSignal["terminationReason"];
    let fullyIdle: boolean | undefined;
    if (event === "Stop") {
      const reason = value["terminationReason"];
      if (
        reason !== "model_stop" &&
        reason !== "NO_TOOL_CALL" &&
        reason !== "max_steps_exceeded" &&
        reason !== "error"
      )
        throw new Error("Invalid termination reason");
      if (typeof value["fullyIdle"] !== "boolean") throw new Error("Invalid idle state");
      terminationReason = reason === "NO_TOOL_CALL" ? "model_stop" : reason;
      fullyIdle = value["fullyIdle"];
    }
    if (session.sequence !== undefined && sequence <= session.sequence) return;
    session.sequence = sequence;
    session.agentId = agentId;
    return {
      terminalId: session.terminalId,
      signal: `agy:${event}`,
      conversationId: agentId,
      action:
        event !== "Stop"
          ? "working"
          : terminationReason !== "model_stop"
            ? "failed"
            : fullyIdle === false
              ? "working"
              : "classify",
      ...(terminationReason === undefined ? {} : { terminationReason }),
      ...(fullyIdle === undefined ? {} : { fullyIdle }),
    };
  }
  const lifecycle = session.agent === "codex" && value["hook_event_name"] !== undefined;
  const agentId =
    session.agent === "claude" || lifecycle ? value["session_id"] : value["thread-id"];
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
  } else {
    switch (value["hook_event_name"]) {
      case "UserPromptSubmit":
        signal = "claude:UserPromptSubmit";
        action = "working";
        break;
      case "PreToolUse":
        signal = "claude:PreToolUse";
        action = "working";
        break;
      case "Stop":
        signal = "claude:Stop";
        break;
      case "PermissionRequest":
        signal = "claude:PermissionRequest";
        action = "needs_input";
        break;
      case "Notification":
        if (typeof value["notification_type"] !== "string") throw new Error("Invalid notification");
        if (value["notification_type"] === "permission_prompt") {
          signal = "claude:permission_prompt";
          action = "needs_input";
        } else if (value["notification_type"] === "idle_prompt") signal = "claude:idle_prompt";
        else return;
        break;
      default:
        if (typeof value["hook_event_name"] !== "string") throw new Error("Invalid hook");
        return;
    }
  }
  session.agentId = agentId;
  return { terminalId: session.terminalId, action, signal, conversationId: agentId };
}
