import { agentProviders } from "../agents/providers/registry";
import { evaluateScreenRules, prepareScreenRules } from "../../shared/providers/screen-rules";
export { ruleRegion } from "../../shared/providers/screen-rules";
export { boundedRegex } from "../../shared/providers/detection";
import { isAgentId } from "../../shared/providers/catalog";
import { bundledAgentData } from "../../shared/bundled-agent-data";
import type { AgentManifest, AgentRule } from "./agent-rule-types";
import type { AgentEvidence } from "../../shared/agent-detection";
import type { AgentId } from "../../shared/agents";

/** Deliberately small regex language: no repetition, groups, alternation or backreferences.
 * Every accepted pattern has bounded, linear work even on adversarial screen text. */

export function parseManifest(
  data: Omit<AgentManifest, "rules"> & {
    rules: readonly (Omit<AgentRule, "state" | "region"> & { state: string; region: string })[];
  },
): AgentManifest {
  // JSON imports are compiled and shipped, never loaded from agent output or a URL.
  if (data.minimumEngineVersion !== 1) throw new Error("Unsupported detection engine");
  const id = data.id;
  if (!isAgentId(id)) throw new Error("Unknown agent");
  const rules = data.rules.map((rule): AgentRule => {
    const state = rule.state;
    const region = rule.region;
    if (state !== "working" && state !== "blocked" && state !== "idle" && state !== "unknown")
      throw new Error("Unknown rule state");
    if (region !== "title" && region !== "bottom" && region !== "after_horizontal_rule")
      throw new Error("Unknown rule region");
    return { ...rule, state, region };
  });
  return { ...data, id, rules };
}
const manifests = [
  ...bundledAgentData.map((data) => ({
    id: data.id,
    version: 1,
    minimumEngineVersion: data.attention.minimumEngineVersion,
    ...data.attention.provenance,
    rules: data.attention.rules,
  })),
].map(parseManifest);
for (const manifest of manifests) prepareScreenRules(manifest.rules);
export { manifests };

/** Budget checks supplement regex restrictions; they cannot interrupt a JS RegExp. */
export function detectAgent(
  agent: AgentId,
  evidence: AgentEvidence,
  tail: readonly string[],
  rules = manifests.find((manifest) => manifest.id === agent)?.rules ??
    agentProviders()
      .find((provider) => provider.id === agent)
      ?.model.attention.rules.map(({ lines, ...rule }) => ({
        ...rule,
        ...(lines === undefined ? {} : { lines }),
      })) ??
    [],
  now: () => number = () => performance.now(),
): AgentRule | undefined {
  return evaluateScreenRules(evidence, tail, rules, now);
}
