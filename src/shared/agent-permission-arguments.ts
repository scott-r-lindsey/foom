import { ApplicationError } from "./application-errors";
import { matchesArguments } from "./agent-argument-matchers";
import { selected } from "./agent-conditions";
import { type DiscoveryFacts, permissionLevelSupported } from "./agent-launch-values";
import type { AgentManifestV2 } from "./agent-manifest-v2";
import type { AgentPermissionLevel } from "./agent-permissions";

export function agentPermissionLevel(value: unknown): value is AgentPermissionLevel {
  return value === "ask" || value === "workspace" || value === "full";
}

export const agentPermissionLabels = {
  ask: "Ask",
  workspace: "Workspace",
  full: "Full access",
} satisfies Record<AgentPermissionLevel, string>;

export function availablePermissionLevels(policy: {
  workspace?: readonly string[] | undefined;
}): AgentPermissionLevel[] {
  return policy.workspace ? ["ask", "workspace", "full"] : ["ask", "full"];
}

export function checkPermissionConflicts(model: AgentManifestV2, args: readonly string[]): void {
  if (
    !model.permissionLevels ||
    matchesArguments(model.permissionLevels.conflicts, args, "root") ||
    matchesArguments(model.bypassArguments, args) ||
    args.includes("--")
  )
    throw new ApplicationError("agent-permission-conflict");
}

export function sandboxBypassMatchers(model: AgentManifestV2) {
  return model.bypassArguments.filter((matcher) => !matcher.approvalOnly);
}

export function applyPermissionArguments(
  model: AgentManifestV2,
  level: AgentPermissionLevel | undefined,
  args: string[],
  index: number,
  facts: DiscoveryFacts,
): string[] {
  if (!level) return args;
  const policy = model.permissionLevels;
  if (!policy || facts[permissionLevelSupported] !== true || !selected(policy.when, facts))
    throw new ApplicationError("agent-permission-unavailable");
  const terminator = args.indexOf("--");
  const optionArgs = terminator === -1 ? args : args.slice(0, terminator);
  if (
    (terminator !== -1 && terminator < index) ||
    matchesArguments(model.bypassArguments, optionArgs) ||
    matchesArguments(policy.conflicts, optionArgs, "root")
  )
    throw new ApplicationError("agent-permission-conflict");
  const permissionArgs = policy[level];
  if (!permissionArgs) throw new ApplicationError("agent-permission-unavailable");
  const bypassMatchers = level === "ask" ? model.bypassArguments : sandboxBypassMatchers(model);
  if (matchesArguments(bypassMatchers, permissionArgs) !== (level === "full"))
    throw new Error("Invalid agent permission declaration.");
  return [...args.slice(0, index), ...permissionArgs, ...args.slice(index)];
}
