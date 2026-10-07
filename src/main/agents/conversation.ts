import type { AgentId } from "../../shared/agents";

/** IDs are opaque CLI data, never options, paths, shell text or display names. */
export function conversationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/u.test(value);
}

export function resumeArguments(agent: AgentId, id: unknown): string[] {
  if (!conversationId(id)) throw new Error("Invalid conversation ID");
  if (agent === "claude") return ["--resume", id];
  if (agent === "codex") return ["resume", id];
  throw new Error("Conversation resume is unavailable for this agent");
}
