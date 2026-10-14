import type { AgentId } from "../../../shared/agents";
import { claudeProvider } from "./claude";
import { codexProvider } from "./codex";
import { agyProvider } from "./agy";
import type { AgentProvider } from "./provider";
export type { AgentProvider } from "./provider";
const builtins: readonly AgentProvider[] = [claudeProvider, codexProvider, agyProvider];
let configured: readonly AgentProvider[] = [];
let revision = 0;
export function providerRevision(): number {
  return revision;
}
export function agentProviders(): readonly AgentProvider[] {
  return [...builtins, ...configured];
}
export function knownAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && agentProviders().some((provider) => provider.id === value);
}
export function agentProvider(id: AgentId): AgentProvider {
  const result = agentProviders().find((provider) => provider.id === id);
  if (!result) throw new Error("Unknown agent");
  return result;
}
/** Called only by main's config approval gate, never from a manifest or IPC. */
export function replaceConfigProviders(providers: readonly AgentProvider[]): void {
  if (
    providers.some((provider) => builtins.some((builtin) => builtin.id === provider.id)) ||
    new Set(providers.map((provider) => provider.id)).size !== providers.length
  )
    throw new Error("Reserved or duplicate agent ID");
  if (
    configured.length === providers.length &&
    configured.every((provider, index) => provider === providers[index])
  )
    return;
  configured = providers;
  revision++;
}
