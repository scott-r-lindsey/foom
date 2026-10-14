export type ArgvTemplate = readonly string[];
export interface DetectionMatcher {
  contains?: string[];
  regex?: string[];
}
export interface DetectionRule {
  id: string;
  state: "working" | "blocked" | "idle" | "unknown";
  priority: number;
  region: "title" | "bottom" | "after_horizontal_rule";
  lines?: number;
  match: DetectionMatcher;
  not?: DetectionMatcher[];
  reason: string;
  comment: string;
}
export interface HookMapping {
  transport: "stdin" | "argv";
  sessionField: string;
  eventField: string;
  events: Readonly<Record<string, "classify" | "needs_input" | "working" | "ready" | "failed">>;
}
export interface AgentPluginManifest {
  kind: "agent";
  version: 1;
  id: string;
  name: string;
  badge: string;
  executables: readonly string[];
  discovery: { hooksHelp: readonly string[]; mcpHelp: readonly string[] };
  launch: {
    arguments: ArgvTemplate;
    prompt: ArgvTemplate;
    resume: ArgvTemplate;
    hooks: ArgvTemplate;
    mcp: ArgvTemplate;
    allowedTools: readonly string[];
  };
  bypassArguments: readonly string[];
  attention: { minimumEngineVersion: 1; rules: DetectionRule[]; hook?: HookMapping };
}
