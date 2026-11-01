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
    "5ad9462bab12fb14b28c96e30897a024c79c692929a694bdbad0bc08edd74e9b",
  ),
  bundledProvider(
    codex,
    "codex",
    "76f9ed4ee169e3aae2c7ec7956f4a24dce3baae34089a0f7a279560ab213348e",
  ),
  bundledProvider(agy, "agy", "d61afcb2294573d0890391678f5c8f0ec9f601c1b6981085dd4c7964e18c0d16"),
  bundledProvider(
    copilot,
    "copilot",
    "6c3dff95c029e7f1575dd2558e0bb3b2d8bb0b37749f2520250cfacd0ef4b731",
  ),
  bundledProvider(
    opencode,
    "opencode",
    "650c094df6a015a030068c02b7df9a1efa26c4e34a75f20f55ea0e28a4a33c44",
  ),
  bundledProvider(pi, "pi", "3360c8d7d855fe8d67d7550820e7b673febf17fc33647e84a3b98185afa822be"),
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
