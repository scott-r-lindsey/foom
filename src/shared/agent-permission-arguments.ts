import { ApplicationError } from "./application-errors";
import { matchesArguments } from "./agent-argument-matchers";
import { selected } from "./agent-conditions";
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
    matchesArguments(model.permissionLevels.conflicts, args) ||
    matchesArguments(model.bypassArguments, args) ||
    args.includes("--")
  )
    throw new ApplicationError("agent-permission-conflict");
}

export function applyPermissionArguments(
  model: AgentManifestV2,
  level: AgentPermissionLevel | undefined,
  args: string[],
  index: number,
  facts: Readonly<Record<string, unknown>>,
): string[] {
  if (!level) return args;
  const policy = model.permissionLevels;
  if (!policy || facts["permissionLevelSupported"] !== true || !selected(policy.when, facts))
    throw new ApplicationError("agent-permission-unavailable");
  if (
    args.slice(0, index).includes("--") ||
    matchesArguments(model.bypassArguments, args) ||
    matchesArguments(policy.conflicts, args)
  )
    throw new ApplicationError("agent-permission-conflict");
  const permissionArgs = policy[level];
  if (!permissionArgs) throw new ApplicationError("agent-permission-unavailable");
  if (matchesArguments(model.bypassArguments, permissionArgs) !== (level === "full"))
    throw new Error("Invalid agent permission declaration.");
  return [...args.slice(0, index), ...permissionArgs, ...args.slice(index)];
}
