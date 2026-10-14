import { agentProvider } from "./providers/registry";
export { conversationId } from "../../shared/conversation";
export function resumeArguments(agent: string, id: unknown): string[] {
  return agentProvider(agent).resume(id);
}
