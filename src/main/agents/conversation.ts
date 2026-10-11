import type { AgentId } from "../../shared/agents";

import { conversationId } from "../../shared/conversation";
export { conversationId } from "../../shared/conversation";

export function resumeArguments(agent: AgentId, id: unknown): string[] {
  if (!conversationId(id)) throw new Error("Invalid conversation ID");
  if (agent === "claude") return ["--resume", id];
  if (agent === "codex") return ["resume", id];
  return ["--conversation", id];
}
