import {
  hasBypassArgument as builtinBypass,
  parseAgentArguments as builtinArguments,
  parseAgentDefaults as builtinDefaults,
  AgentArgumentsError,
} from "../../shared/agent-arguments";
import { matchesArguments } from "./providers/v2-values";
import type { AgentValues } from "../../shared/agents";
import { agentProviders } from "./providers/registry";
export { EMPTY_AGENT_ARGUMENTS } from "../../shared/agent-arguments";
export function hasBypassArgument(agent: string, args: readonly string[]): boolean {
  const provider = agentProviders().find((provider) => provider.id === agent);
  const manifest = provider?.manifest;
  if (provider?.model) return matchesArguments(provider.model.bypassArguments, args);
  return (
    builtinBypass(agent, args) ||
    Boolean(
      manifest?.bypassArguments.some((arg) =>
        [...manifest.launch.arguments, ...args].includes(arg),
      ),
    )
  );
}

export function parseAgentArguments(agent: string, value: unknown): readonly string[] {
  const args = builtinArguments(agent, value);
  const model = agentProviders().find((provider) => provider.id === agent)?.model;
  if (model && matchesArguments(model.reservedArguments, args))
    throw new AgentArgumentsError("These arguments are reserved for Foom session actions.");
  return args;
}
export function parseAgentDefaults(value: unknown): AgentValues<readonly string[]> {
  const parsed = builtinDefaults(value);
  for (const [agent, args] of Object.entries(parsed)) parseAgentArguments(agent, args);
  return parsed;
}

/** Loading may discard one newly protected provider list without losing other defaults. */
export function recoverAgentDefaults(
  value: AgentValues<readonly string[]>,
): AgentValues<readonly string[]> {
  const recovered = { ...value };
  for (const [agent, args] of Object.entries(value)) {
    try {
      recovered[agent] = parseAgentArguments(agent, args);
    } catch {
      recovered[agent] = [];
    }
  }
  return recovered;
}
