import { createHash } from "node:crypto";
import agy from "../../../shared/bundled-agents/agy.json";
import codex from "../../../shared/bundled-agents/codex.json";
import claude from "../../../shared/bundled-agents/claude.json";
import { parseAgentManifest } from "../../../shared/agent-plugin-parser";
import type { AgentProvider } from "./provider";
import { v2Provider } from "./v2";

/** Build-owned lock: JSON cannot nominate itself as bundled or supply its own digest. */
export function bundledProvider(
  data: unknown,
  id: string,
  digest: string,
  legacyConsentDigest?: string,
): AgentProvider {
  const source = JSON.stringify(data);
  if (createHash("sha256").update(source).digest("hex") !== digest)
    throw new Error("Bundled agent manifest integrity mismatch");
  const parsed = parseAgentManifest(source, "bundled");
  if (parsed.model.id !== id) throw new Error("Invalid bundled agent manifest identity");
  return {
    ...v2Provider(parsed.model, () => Promise.resolve()),
    origin: "bundled",
    legacyChannelConsent: digest === legacyConsentDigest,
  };
}

// Versioned with the application. Update the lock only alongside reviewed manifest changes.
export const bundledProviders: readonly AgentProvider[] = [
  bundledProvider(
    claude,
    "claude",
    "1a4ed1e8af60f50023e00af0102417d3f09c1ebec695ee92946ff87ae0998d05",
  ),
  bundledProvider(
    codex,
    "codex",
    "254c14d9219be5bcde6a87481c90e45f15a7de09d77153f47cd887fb670bc73e",
    // Equivalent legacy profile disclosure; revisions require an explicit consent review.
    "254c14d9219be5bcde6a87481c90e45f15a7de09d77153f47cd887fb670bc73e",
  ),
  bundledProvider(agy, "agy", "55686741f8b5f2b47df50f2fe429b6c6b01a319f0c46c41f28e35ce2be7094b7"),
];
