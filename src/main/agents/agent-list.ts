import type { AgentId } from "../../shared/agents";
/** The supported agents, in display order. Main is the only source of this list. */
export const AGENTS: readonly { id: AgentId; name: string; mark: string }[] = [
  { id: "claude", name: "Claude Code", mark: "CC" },
  { id: "codex", name: "Codex", mark: "CX" },
  { id: "agy", name: "Antigravity", mark: "AG" },
];
