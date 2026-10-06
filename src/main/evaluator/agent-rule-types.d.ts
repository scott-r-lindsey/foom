import type { AgentId } from "../../shared/agents";
export interface Matcher {
  contains?: string[];
  regex?: string[];
}
export interface AgentRule {
  id: string;
  state: "working" | "blocked" | "idle" | "unknown";
  priority: number;
  region: "title" | "bottom" | "after_horizontal_rule";
  lines?: number;
  match: Matcher;
  not?: Matcher[];
  reason: string;
  comment: string;
}
export interface AgentManifest {
  id: AgentId;
  version: number;
  minimumEngineVersion: number;
  source: string;
  license: string;
  modified: string;
  rules: AgentRule[];
}
