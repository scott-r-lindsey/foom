import type { AgentInstallation } from "../../src/shared/agents";
import type { Settings, SetupState } from "../../src/shared/setup";
import type { AgentReport } from "../../src/shared/workspace";

export function setupState(
  settings: Partial<Settings> = {},
  rest: Partial<Omit<SetupState, "settings">> = {},
): SetupState {
  return {
    settings: {
      setupComplete: false,
      hooks: true,
      agents: { claude: true, codex: true, agy: true },
      worktreeLocation: "root",
      inference: { kind: "rules" },
      inferenceTimeoutMs: 5000,
      colorMode: "system",
      interfaceScale: 100,
      codeFolder: null,
      ...settings,
    },
    keys: { anthropic: false, openai: false, google: false },
    secureStorage: true,
    worktreeRoot: "/home/me/.foom/worktrees",
    ...rest,
  };
}

/** What each agent's `--version` really prints, worded differently by each. */
const VERSIONS = {
  claude: "2.1.300 (Claude Code)",
  codex: "codex-cli 0.155.1",
  agy: "1.2.13",
} as const;

export function installation(
  id: AgentInstallation["id"],
  found = true,
  hooks = id !== "agy",
): AgentInstallation {
  return {
    id,
    path: found ? `/bin/${id}` : null,
    version: found ? VERSIONS[id] : null,
    hooks: found && hooks,
    reason: found
      ? hooks
        ? "Hooks supported"
        : "Unverified hook support; using output evaluation."
      : "Not found on PATH",
  };
}

export function report(...agents: AgentInstallation[]): AgentReport {
  return { warning: null, agents };
}
