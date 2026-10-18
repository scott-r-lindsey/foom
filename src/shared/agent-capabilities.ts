import type { ManifestCondition, ParsedAgentPlugin } from "./agent-manifest-v2";
import { selected } from "./agent-conditions";

import type { Availability, AgentCapabilityReport } from "./agent-capability-report";
type Truth = boolean | undefined;
const availability = (value: Truth): Availability =>
  value === false ? "off" : value === true ? "on" : "gated by facts";

/** Conservative offline analysis: unknown probe/launch facts are never treated as disabled. */
function condition(when: ManifestCondition | undefined, facts: ReadonlyMap<string, Truth>): Truth {
  const test = (entry: NonNullable<ManifestCondition["all"]>[number]): Truth => {
    const key = typeof entry.field === "string" ? entry.field : String(entry.field.path[0]);
    const value = facts.get(key);
    if (value === undefined) return undefined;
    return selected({ all: [entry], any: undefined }, { [key]: value });
  };
  const all = when?.all?.map(test) ?? [];
  const any = when?.any?.map(test);
  if (all.includes(false) || (any !== undefined && any.every((value) => value === false)))
    return false;
  if (all.includes(undefined) || (any !== undefined && !any.includes(true))) return undefined;
  return true;
}

/** Only parsed manifest data enters this report; all output labels are fixed strings. */
export function agentCapabilities(plugin: Pick<ParsedAgentPlugin, "model">): AgentCapabilityReport {
  const model = plugin.model;
  const facts = new Map<string, Truth>([["hooksEnabled", true]]);
  for (const fact of model.discovery.facts) {
    const gate = condition(fact.when, facts);
    facts.set(
      fact.id,
      !fact.enabled || gate === false
        ? false
        : fact.minimum || model.discovery.version?.minimum || fact.helpTokens.length
          ? undefined
          : gate,
    );
  }
  const channels = (model.hooks?.channels ?? []).map((channel) => {
    const value = condition(channel.when, facts);
    facts.set(`channelAttached:${channel.id}`, value);
    return availability(value);
  });
  const hooks = channels.some((channel) => channel !== "off");
  const rules = model.attention.rules.length;
  const mcp = model.launch.mcp ? availability(condition(model.launch.mcp.when, facts)) : "off";
  const warnings: string[] = [];
  if (!rules && !hooks) warnings.push("No attention signal");
  if (model.launch.resume && !model.conversation.newId && !hooks)
    warnings.push("Resume declared with no ID source; paste a conversation ID");
  if (channels.includes("off")) warnings.push("Hooks gated by an always-disabled fact");
  if (model.launch.mcp && mcp === "off") warnings.push("MCP gated by an always-disabled fact");
  return {
    id: model.id,
    attention: { rules, channels },
    completion: model.execution.completion,
    resume: !model.launch.resume
      ? "none"
      : model.conversation.newId
        ? "Foom-assigned ID"
        : hooks
          ? "hook-reported session"
          : "paste only",
    mcp,
    foomTools: model.launch.toolPermissions?.names.length ? mcp : "off",
    bypass: {
      argumentMatchers: model.bypassArguments.length,
      environmentVariables: model.bypassEnvironment.length,
    },
    warnings,
  };
}

export function formatAgentCapabilities(report: AgentCapabilityReport): string {
  const { rules, channels } = report.attention;
  const hooks = channels.filter((channel) => channel !== "off");
  const attention = hooks.length
    ? `hooks (${String(hooks.length)}; ${hooks.includes("gated by facts") ? "gated by facts" : "enabled-by-default"})${rules ? ` + screen rules (${String(rules)})` : ""}`
    : rules
      ? `screen rules (${String(rules)})`
      : "none";
  return [
    `Agent ${report.id}`,
    `  Attention: ${attention}`,
    `  Completion: ${report.completion}`,
    `  Resume: ${report.resume}`,
    `  MCP: ${report.mcp}; Foom tools: ${report.foomTools}`,
    `  Bypass: ${String(report.bypass.argumentMatchers)} argument matchers; ${String(report.bypass.environmentVariables)} environment variables`,
    ...report.warnings.map((warning) => `  Warning: ${warning}`),
  ].join("\n");
}
