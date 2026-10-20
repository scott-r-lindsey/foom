import { createHash } from "node:crypto";
import agy from "../../../shared/bundled-agents/agy.json";
import codex from "../../../shared/bundled-agents/codex.json";
import claude from "../../../shared/bundled-agents/claude.json";
import { parseAgentManifest } from "../../../shared/agent-plugin-parser";
import type { AgentProvider } from "./provider";
import { v2Provider } from "./v2";

/** Build-owned lock: JSON cannot nominate itself as bundled or supply its own digest. */
export function bundledProvider(data: unknown, id: string, digest: string): AgentProvider {
  const source = JSON.stringify(data);
  if (createHash("sha256").update(source).digest("hex") !== digest)
    throw new Error("Bundled agent manifest integrity mismatch");
  const parsed = parseAgentManifest(source, "bundled");
  if (parsed.model.id !== id) throw new Error("Invalid bundled agent manifest identity");
  return {
    ...v2Provider(parsed.model, () => Promise.resolve()),
    origin: "bundled",
  };
}

// Versioned with the application. Update the lock only alongside reviewed manifest changes.
export const bundledProviders: readonly AgentProvider[] = [
  bundledProvider(
    claude,
    "claude",
    "6ec204db4a3fa9bba4de6d546bbdf1ca719d98c52e8d7c9b56db45f736b4af74",
  ),
  bundledProvider(
    codex,
    "codex",
    "0516f60ea277d9edb45850f2060a9fe8ae20f1ff28bc89f20aa0e0a078285d5f",
  ),
  bundledProvider(agy, "agy", "55686741f8b5f2b47df50f2fe429b6c6b01a319f0c46c41f28e35ce2be7094b7"),
];
