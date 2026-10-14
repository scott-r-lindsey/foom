import { BUILTIN_POLICIES } from "../../shared/providers/catalog";
import type { AgentId } from "../../shared/agents";

import { conversationId } from "../../shared/conversation";
export { conversationId } from "../../shared/conversation";

export function resumeArguments(agent: AgentId, id: unknown): string[] {
  if (!conversationId(id)) throw new Error("Invalid conversation ID");
  return [BUILTIN_POLICIES[agent].resume[0], id];
}
