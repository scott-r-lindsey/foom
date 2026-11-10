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
    "0863669e0c9ee37458ce376da7e872c1e4df741dfeeeddcd510c08cf0e7da648",
  ),
  bundledProvider(
    codex,
    "codex",
    "1308b581996bb2a31e0657382f28059bcd05162da1addde9be49e68ec4f5442f",
  ),
  bundledProvider(agy, "agy", "5064d9514d4c1ea4c5de6577da1e53c10d03848d8d634497eec246243aaa5954"),
  bundledProvider(
    copilot,
    "copilot",
    "8a20aa762114ba3ba2025634d3cfe13f03f78e27d05f5eed6eafdef43516da0b",
  ),
  bundledProvider(
    opencode,
    "opencode",
    "2c1eca2b170e42f19f65ae893935744c8d47468763f26cfab3e26c5eac0ea315",
  ),
  bundledProvider(pi, "pi", "5074f7a22784f37b30eb1df1ebac3054e03b6b154e3d65ad320e117ddd346177"),
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
