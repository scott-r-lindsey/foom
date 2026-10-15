import type { BuiltinAgentId } from "../agents";

import { bundledAgentData } from "../bundled-agent-data";

/** Display and compatibility metadata only; the model owns bundled launch policy. */
const bundledPolicies = bundledAgentData.map((data) => ({
  id: data.id,
  name: data.name,
  mark: data.badge,
  command: data.executables[0] ?? data.id,
  resume: data.resumePaste.map((pattern) => pattern.selector),
  // Converted providers use the generic setup/health engine, never legacy adapters.
  hookHealth: false,
  pluginSetup: "setup" in data,
  completionHook: data.execution.completion === "attached",
  restoreControl: data.conversation.restoreControl,
}));
const codex = {
  id: "codex",
  name: "Codex",
  mark: "CX",
  command: "codex",
  resume: ["resume"],
  hookHealth: true,
  pluginSetup: false,
  completionHook: false,
  restoreControl: true,
} as const;
/** Built-in policy metadata shared with the UI; no process capabilities cross IPC. */
export const BUILTIN_AGENTS = [...bundledPolicies.slice(0, 1), codex, ...bundledPolicies.slice(1)];

export function builtinAgent(id: string | undefined) {
  return BUILTIN_AGENTS.find((entry) => entry.id === id);
}
export function isAgentId(id: unknown): id is BuiltinAgentId {
  return typeof id === "string" && builtinAgent(id) !== undefined;
}

export const BUILTIN_POLICIES = {
  codex,
};

/** Syntactic ID validation grants no installation or launch authority. */
export function validAgentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    /^[a-z][a-z0-9-]*$/u.test(value) &&
    !["shell", "all", "constructor", "prototype", "__proto__"].includes(value)
  );
}
