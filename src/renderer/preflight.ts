import type { AgentId, AgentInstallation } from "../shared/agents";
import type { ApiProvider, InferenceConfig } from "../shared/inference";
import type { SetupState } from "../shared/setup";
import type { AgentReport } from "../shared/workspace";
import type { Repository } from "../shared/worktrees";

export const STEPS = [
  { t: "", label: "Welcome" },
  { t: "T-3", label: "Agents" },
  { t: "T-2", label: "Repositories" },
  { t: "T-1", label: "Evaluator" },
  { t: "T-0", label: "Go / no-go" },
] as const;

export const AGENTS: readonly { id: AgentId; name: string; command: string; signal: string }[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    signal: "Stop, permission and notification hooks tell Foom when it finishes or asks.",
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    signal:
      "Foom's notifier runs when a turn completes. It replaces your own notifier for Foom's launches only.",
  },
  {
    id: "agy",
    name: "Antigravity",
    command: "agy",
    signal: "No per-launch hooks yet, so Foom reads its output when it goes quiet.",
  },
];

export const PROVIDERS: readonly { id: ApiProvider; label: string; model: string }[] = [
  { id: "anthropic", label: "Anthropic", model: "claude-haiku-4-5" },
  { id: "openai", label: "OpenAI", model: "gpt-4.1-mini" },
  { id: "google", label: "Google", model: "gemini-2.5-flash" },
];

/** The sample Run check sends; main uses the same line. */
export const SAMPLE_TAIL = "Would you like me to apply these changes?";

export function agentName(id: AgentId): string {
  return AGENTS.find((agent) => agent.id === id)?.name ?? id;
}

export function found(report: AgentReport | undefined, id: AgentId) {
  return report?.agents.find((agent) => agent.id === id && agent.path !== null);
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
export function signal(agent: AgentInstallation, hooks: boolean): "hooks" | "notify" | "evaluator" {
  if (!hooks || !agent.hooks) return "evaluator";
  return agent.id === "codex" ? "notify" : "hooks";
}

export function inferenceSummary(config: InferenceConfig): string {
  if (config.kind === "rules") return "Rules only. Ambiguous terminals stay neutral";
  if (config.kind === "local") return `Local · ${config.model} at ${config.endpoint}`;
  const provider = PROVIDERS.find((entry) => entry.id === config.kind);
  return `${provider?.label ?? config.kind} API · ${config.model}`;
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
  const { inference, hooks, worktreeLocation } = state.settings;
  const keyMissing =
    inference.kind !== "rules" && inference.kind !== "local" && !state.keys[inference.kind];
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
      step: 2,
    },
    {
      system: "Evaluator",
      go: !keyMissing,
      detail: keyMissing ? "The API key for this source is missing" : inferenceSummary(inference),
      step: 3,
    },
  ];
}
