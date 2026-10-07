import claude from "./agent-rules/claude.json";
import codex from "./agent-rules/codex.json";
import agy from "./agent-rules/agy.json";
import type { AgentManifest, AgentRule, Matcher } from "./agent-rule-types";
import type { AgentEvidence } from "../../shared/agent-detection";
import type { AgentId } from "../../shared/agents";

/** Deliberately small regex language: no repetition, groups, alternation or backreferences.
 * Every accepted pattern has bounded, linear work even on adversarial screen text. */
export function boundedRegex(pattern: string): RegExp {
  if (
    pattern.length === 0 ||
    pattern.length > 128 ||
    /[()*+?{}|]/.test(pattern) ||
    /\\[^sSdDwW\\.[\]\-^$]/.test(pattern)
  )
    throw new Error("Unsafe detection regex");
  return new RegExp(pattern, "iu");
}

export function parseManifest(data: typeof claude | typeof codex | typeof agy): AgentManifest {
  // JSON imports are compiled and shipped, never loaded from agent output or a URL.
  if (data.minimumEngineVersion !== 1) throw new Error("Unsupported detection engine");
  const id = data.id;
  if (id !== "claude" && id !== "codex" && id !== "agy") throw new Error("Unknown agent");
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
const manifests = [claude, codex, agy].map(parseManifest);
const compiled = new Map<string, RegExp>();
for (const manifest of manifests) {
  for (const rule of manifest.rules) {
    for (const matcher of [rule.match, ...(rule.not ?? [])]) {
      for (const pattern of matcher.regex ?? []) compiled.set(pattern, boundedRegex(pattern));
    }
  }
}
export { manifests };

export function ruleRegion(
  rule: AgentRule,
  evidence: AgentEvidence,
  tail: readonly string[],
): string {
  if (rule.region === "title") return evidence.title;
  const lines = tail.slice(-40).map((line) => line.slice(0, 500));
  if (rule.region === "after_horizontal_rule") {
    const index = lines.findLastIndex((line) => /^[─━╌-]{3,}$/.test(line.trim()));
    return lines.slice(index + 1).join("\n");
  }
  return lines
    .filter((line) => line.trim())
    .slice(-(rule.lines ?? 12))
    .join("\n");
}

function matches(matcher: Matcher, text: string): boolean {
  return (
    (matcher.contains ?? []).every((part) => text.toLowerCase().includes(part.toLowerCase())) &&
    (matcher.regex ?? []).every((pattern) =>
      (compiled.get(pattern) ?? boundedRegex(pattern)).test(text),
    )
  );
}

/** Budget checks supplement regex restrictions; they cannot interrupt a JS RegExp. */
export function detectAgent(
  agent: AgentId,
  evidence: AgentEvidence,
  tail: readonly string[],
  rules = manifests.find((manifest) => manifest.id === agent)?.rules ?? [],
  now: () => number = () => performance.now(),
): AgentRule | undefined {
  const deadline = now() + 5;
  for (const rule of [...rules].sort((a, b) => b.priority - a.priority)) {
    if (now() > deadline) return undefined;
    const text = ruleRegion(rule, evidence, tail);
    const matched =
      matches(rule.match, text) && !(rule.not ?? []).some((exclusion) => matches(exclusion, text));
    if (now() > deadline) return undefined;
    if (matched) return rule;
  }
  return undefined;
}
