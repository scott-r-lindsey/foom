import type { AgentManifestV2 } from "./agent-manifest-v2";
export type Availability = "off" | "gated by facts" | "on";
export interface AgentCapabilityReport {
  id: string;
  attention: { rules: number; channels: Availability[] };
  completion: AgentManifestV2["execution"]["completion"];
  resume: "none" | "Foom-assigned ID" | "hook-reported session" | "paste only";
  mcp: Availability;
  foomTools: Availability;
  bypass: { argumentMatchers: number; environmentVariables: number };
  warnings: string[];
}
