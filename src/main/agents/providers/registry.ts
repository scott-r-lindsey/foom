import type { AgentId } from "../../../shared/agents";
import { claudeProvider } from "./claude";
import { codexProvider } from "./codex";
import { agyProvider } from "./agy";
import type { AgentProvider } from "./provider";
export type { AgentProvider } from "./provider";
export const providers: readonly AgentProvider[] = [claudeProvider, codexProvider, agyProvider];
const registry: Readonly<Record<AgentId, AgentProvider>> = {
  claude: claudeProvider,
  codex: codexProvider,
  agy: agyProvider,
};
export function agentProvider(id: AgentId): AgentProvider {
  return registry[id];
}
