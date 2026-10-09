import type { AgentId, AgentInstallation } from "../../shared/agents";
import type { SetupState } from "../../shared/setup";
import type { AgentReport } from "../../shared/workspace";
import type { Repository } from "../../shared/worktrees";

export const STEPS = [
  { t: "", label: "Welcome" },
  { t: "T-3", label: "Agents" },
  { t: "T-2", label: "Repositories" },
  { t: "T-1", label: "Worktrees" },
  { t: "T-0", label: "Go / no-go" },
] as const;

export const AGENTS: readonly { id: AgentId; name: string; command: string }[] = [
  { id: "claude", name: "Claude Code", command: "claude" },
  { id: "codex", name: "Codex", command: "codex" },
  { id: "agy", name: "Antigravity", command: "agy" },
];

/** What each signal means, for the tag's tooltip. */
export const SIGNALS = {
  hooks: "Observer hooks tell Foom when an agent works, stops or asks for permission.",
  notify: "Codex runs Foom's notifier each time a turn completes.",
  rules: "Foom reads the agent's output when it goes quiet and decides what it means.",
} as const;

/**
 * More about how this agent signals, for the tag's tooltip: Codex's notifier
 * replacement, or why an agent that normally has hooks can't use them.
 */
export function signalNote(agent: AgentInstallation, hooks: boolean): string | undefined {
  const how = signal(agent, hooks);
  if (how === "notify") return "Replaces your own Codex notifier, for Foom's launches only.";
  if (how === "rules" && hooks && agent.id !== "agy") return agent.reason;
  return undefined;
}

/**
 * The version number in an agent's `--version` output, which each agent words
 * differently ("2.1.285 (Claude Code)", "codex-cli 0.155.1"); null when there isn't one.
 */
export function versionNumber(output: string | null): string | null {
  if (output === null) return null;
  return /\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?/.exec(output)?.[0] ?? null;
}

export function agentName(id: AgentId): string {
  return AGENTS.find((agent) => agent.id === id)?.name ?? id;
}

export function found(report: AgentReport | undefined, id: AgentId) {
  return report?.agents.find(
    (agent): agent is AgentInstallation & { path: string } =>
      agent.id === id && agent.path !== null,
  );
}

/** Installed and switched on. */
export function readyAgents(
  report: AgentReport | undefined,
  state: SetupState,
): AgentInstallation[] {
  return AGENTS.flatMap(({ id }) => {
    const agent = found(report, id);
    return agent && state.settings.agents[id] ? [agent] : [];
  });
}

/** How this agent will tell Foom it needs attention. */
export function signal(agent: AgentInstallation, hooks: boolean): "hooks" | "notify" | "rules" {
  if (!hooks || !agent.hooks) return "rules";
  return agent.id === "codex" && agent.codexHookState !== "trusted" ? "notify" : "hooks";
}

/** Where `feat/search` would land. Branch slashes become folders. */
export function examplePath(state: SetupState, repositories: readonly Repository[]): string {
  const first = repositories[0];
  if (state.settings.worktreeLocation === "adjacent")
    return `${first?.path ?? "~/code/app"}-feat/search`;
  return `${state.worktreeRoot}/${first?.name ?? "app"}/feat/search`;
}

export interface PollRow {
  system: string;
  go: boolean;
  detail: string;
  step: number;
}

export function pollRows(
  state: SetupState,
  report: AgentReport | undefined,
  repositories: readonly Repository[],
): PollRow[] {
  const ready = readyAgents(report, state);
  const { hooks, worktreeLocation } = state.settings;
  return [
    {
      system: "Agents",
      go: ready.length > 0,
      detail: ready.length
        ? ready.map((agent) => agentName(agent.id)).join(", ")
        : report
          ? "None ready. Install Claude Code, Codex or Antigravity, then scan again"
          : "Still scanning",
      step: 1,
    },
    {
      system: "Signals",
      go: true,
      detail:
        ready.map((agent) => `${agentName(agent.id)}: ${signal(agent, hooks)}`).join(" · ") ||
        "Nothing to watch yet",
      step: 1,
    },
    {
      system: "Repositories",
      go: repositories.length > 0,
      detail: repositories.length
        ? repositories.map((repository) => repository.name).join(", ")
        : "None added. Add at least one",
      step: 2,
    },
    {
      system: "Worktrees",
      go: true,
      detail: worktreeLocation === "root" ? state.worktreeRoot : "Next to each repository",
      step: 3,
    },
  ];
}
