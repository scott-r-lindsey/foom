import { hasBypassArgument as builtinBypass } from "../../shared/agent-arguments";
import { agentProviders } from "./providers/registry";
export {
  EMPTY_AGENT_ARGUMENTS,
  parseAgentArguments,
  parseAgentDefaults,
} from "../../shared/agent-arguments";
export function hasBypassArgument(agent: string, args: readonly string[]): boolean {
  const manifest = agentProviders().find((provider) => provider.id === agent)?.manifest;
  return (
    builtinBypass(agent, args) ||
    Boolean(
      manifest?.bypassArguments.some((arg) =>
        [...manifest.launch.arguments, ...args].includes(arg),
      ),
    )
  );
}
