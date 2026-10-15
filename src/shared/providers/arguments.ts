import { bundledAgentData } from "../bundled-agent-data";
import { parseAgentManifest } from "../agent-plugin-parser";
import { argumentMatchIndex, matchesArguments } from "../agent-argument-matchers";
import { builtinAgent, validAgentId } from "./catalog";
import type { AgentId, AgentValues } from "../agents";

export const EMPTY_AGENT_ARGUMENTS: AgentValues<readonly string[]> = Object.freeze({
  claude: Object.freeze([]),
  codex: Object.freeze([]),
  agy: Object.freeze([]),
});

function bundledModel(agent: AgentId) {
  const data = bundledAgentData.find((entry) => entry.id === agent);
  return data ? parseAgentManifest(JSON.stringify(data), "bundled").model : undefined;
}

export function hasBypassArgument(agent: AgentId, args: readonly string[]): boolean {
  const model = bundledModel(agent);
  if (model) return matchesArguments(model.bypassArguments, args);
  return false;
}

export class AgentArgumentsError extends Error {}

function argumentError(agent: AgentId, index: number, message: string): Error {
  return new AgentArgumentsError(
    `${builtinAgent(agent)?.name ?? agent}, line ${String(index + 1)}: ${message}`,
  );
}

/** Copy argv without trimming, splitting, quote interpretation, or shell expansion. */
export function parseAgentArguments(agent: AgentId, value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new AgentArgumentsError(
      `${builtinAgent(agent)?.name ?? agent}: use a list of at most 64 default arguments.`,
    );
  const args: string[] = [];
  for (const [index, arg] of value.entries()) {
    if (typeof arg !== "string" || arg.length === 0 || arg.length > 4096 || /\p{Cc}/u.test(arg))
      throw argumentError(
        agent,
        index,
        "Each argument must contain 1–4096 characters, with no control characters.",
      );
    args.push(arg);
  }
  for (const [index, arg] of args.entries()) {
    if (arg === "--")
      throw argumentError(
        agent,
        index,
        "The -- argument would prevent Foom from attaching its flags.",
      );
    if (arg === "--no-alt-screen" || arg.startsWith("--no-alt-screen="))
      throw argumentError(agent, index, "--no-alt-screen is reserved for Foom's terminal display.");
  }
  const model = bundledModel(agent);
  if (model && matchesArguments(model.reservedArguments, args)) {
    const index = argumentMatchIndex(model.reservedArguments, args);
    throw argumentError(agent, index, "These arguments are reserved for Foom session actions.");
  }
  return Object.freeze(args);
}

export function parseAgentDefaults(value: unknown): AgentValues<readonly string[]> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length > 100 ||
    !("claude" in value) ||
    !("codex" in value) ||
    !("agy" in value)
  )
    throw new AgentArgumentsError(
      "Default arguments must name Claude Code, Codex and Antigravity.",
    );
  const result: Record<string, readonly string[]> & {
    claude: readonly string[];
    codex: readonly string[];
    agy: readonly string[];
  } = { claude: [], codex: [], agy: [] };
  for (const [id, args] of Object.entries(value)) {
    if (!validAgentId(id)) throw new AgentArgumentsError("Invalid agent ID");
    result[id] = parseAgentArguments(id, args);
  }
  return Object.freeze(result);
}
