import { createHash } from "node:crypto";
import opencode from "../../../shared/bundled-agents/opencode.json";
import pi from "../../../shared/bundled-agents/pi.json";
import agy from "../../../shared/bundled-agents/agy.json";
import copilot from "../../../shared/bundled-agents/copilot.json";
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
    "7741c7d4fc2ba9197ae2cdf9c3f0c6e6bd2fc5332bd94d8939d9b9c639bc6d03",
  ),
  bundledProvider(
    codex,
    "codex",
    "76f9ed4ee169e3aae2c7ec7956f4a24dce3baae34089a0f7a279560ab213348e",
  ),
  bundledProvider(agy, "agy", "023953c72d36e8500cbbb1039353c23a1afbbd3a0010f2eeb6cd84528cd0f640"),
  bundledProvider(
    copilot,
    "copilot",
    "488e9800fe5cee3327a44f5095aa492f33ec4d6ff0ea1de4257e8cf73f087a5d",
  ),
  bundledProvider(
    opencode,
    "opencode",
    "050f6a0f72b29e98b7c6e11941812eeb90cd4b8c2a39113654d84336c318a943",
  ),
  bundledProvider(pi, "pi", "2aa9b1fe9a4de01c91e5523aaa7e78d2d604291a5fc241beb2954f4f159125d8"),
];

/** Build-owned migrations: retain old config rows, but require an explicit bundled resume. */
export const formerConfigAgentIds: readonly string[] = ["opencode", "pi"];

/** Historical build identities: these IDs were reserved before config providers existed.
 * Never extend this attestation to a newly bundled ID or repin it for a changed policy.
 */
export const legacyBypassIdentities: Readonly<Record<string, string>> = {
  claude: "54a71151ba88212c7996eba9db23c45f1e4f76f39fa46021e84c8d59b2224951",
  codex: "922ba73e610b0e13d165e3302b1b202da3bb06c9a61354c56d1e9d81faa00b4b",
  agy: "2beab2f2d06ceab9a39cb0fe33726e15928ce610ce56028d93acc1a3ac929c21",
};
