import type * as schema from "./agent-manifest-schema";
export type AgentManifestV2 = ReturnType<typeof schema.v2>;
export type ManifestCondition = ReturnType<typeof schema.condition>;
export type ManifestSelector = ReturnType<typeof schema.selector>;
export type ManifestChannel = ReturnType<typeof schema.channel>;
export type ManifestFile = ReturnType<typeof schema.file>;

export type ParsedAgentPlugin = {
  version: 2;
  model: AgentManifestV2;
  templateDialect: "v2";
  helpMatching: "option-boundary";
};
