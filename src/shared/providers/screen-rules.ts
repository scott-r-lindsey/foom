import type { AgentRule, Matcher } from "../agent-rule-types";
import type { AgentEvidence } from "../agent-detection";
import { boundedRegex } from "./detection";
const compiled = new Map<string, RegExp>();
export function prepareScreenRules(rules: readonly AgentRule[]): void {
  for (const rule of rules)
    for (const matcher of [rule.match, ...(rule.not ?? [])])
      for (const pattern of matcher.regex ?? []) compiled.set(pattern, boundedRegex(pattern));
}
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

/** The live and capture paths share regions, priority, exclusions and the same time budget. */
export function evaluateScreenRules(
  evidence: AgentEvidence,
  tail: readonly string[],
  rules: AgentRule[],
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
