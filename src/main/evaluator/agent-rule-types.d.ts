import type { AgentManifest, AgentRule } from "../../shared/agent-rule-types";
export type { Matcher, AgentRule, AgentManifest } from "../../shared/agent-rule-types";

export type RawAgentManifest = Omit<AgentManifest, "id" | "rules"> & {
  id: string;
  rules: (Omit<AgentRule, "state" | "region"> & { state: string; region: string })[];
};
