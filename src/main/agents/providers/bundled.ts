import { createHash } from "node:crypto";
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
  if (parsed.version !== 2 || parsed.model.id !== id)
    throw new Error("Invalid bundled agent manifest identity");
  return { ...v2Provider(parsed.model, () => Promise.resolve()), origin: "bundled" };
}

// Versioned with the application. Update the lock only alongside reviewed manifest changes.
export const bundledProviders: readonly AgentProvider[] = [
  bundledProvider(
    claude,
    "claude",
    "261d384290c97c03ee26f80a04b43a0dfd52ff12dc43ba6575635f32c604ac22",
  ),
];
