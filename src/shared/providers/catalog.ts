import type { AgentId } from "../agents";

/** Built-in policy metadata shared with the UI; no process capabilities cross IPC. */
export const BUILTIN_AGENTS = [
  {
    id: "claude",
    name: "Claude Code",
    mark: "CC",
    command: "claude",
    resume: ["--resume", "-r"],
    hookHealth: false,
    pluginSetup: false,
    completionHook: true,
    restoreControl: true,
  },
  {
    id: "codex",
    name: "Codex",
    mark: "CX",
    command: "codex",
    resume: ["resume"],
    hookHealth: true,
    pluginSetup: false,
    completionHook: false,
    restoreControl: true,
  },
  {
    id: "agy",
    name: "Antigravity",
    mark: "AG",
    command: "agy",
    resume: ["--conversation"],
    hookHealth: false,
    pluginSetup: true,
    completionHook: true,
    restoreControl: false,
  },
] as const;

export function builtinAgent(id: string | undefined) {
  return BUILTIN_AGENTS.find((entry) => entry.id === id);
}
export function isAgentId(id: unknown): id is AgentId {
  return typeof id === "string" && builtinAgent(id) !== undefined;
}

export const BUILTIN_POLICIES = {
  claude: BUILTIN_AGENTS[0],
  codex: BUILTIN_AGENTS[1],
  agy: BUILTIN_AGENTS[2],
} as const;
