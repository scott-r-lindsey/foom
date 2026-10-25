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
    "68bcf38cd5432680ce3d293b6a453129aa8b59dafd98127b5d51e0a085973dd5",
  ),
  bundledProvider(
    codex,
    "codex",
    "e5afbef90ce00779271cbebb22f0571f76446d16ef355674d7ebd8e9a3061c9d",
  ),
  bundledProvider(agy, "agy", "db7f8b59d03461d2d7e7d1d1af8f54419ba76e9f625b3b083e5b83c15d8fb668"),
  bundledProvider(
    copilot,
    "copilot",
    "d06d9f7f37417e2fb022e15d257aefe5005861b023af420655b6706088c5c088",
  ),
  bundledProvider(
    opencode,
    "opencode",
    "c732911ab07e95876cf273d9a7cd1aa0a889a8a90c5078fb1884665ee8dc6508",
  ),
  bundledProvider(pi, "pi", "c991bbc7073a9bd168dc7321a64850e12660f739932caa57ff516653acbc13f6"),
];

/** Build-owned migrations: retain old config rows, but require an explicit bundled resume. */
export const formerConfigAgentIds: readonly string[] = ["opencode"];

/** Historical build identities: these IDs were reserved before config providers existed.
 * Never extend this attestation to a newly bundled ID or repin it for a changed policy.
 */
export const legacyBypassIdentities: Readonly<Record<string, string>> = {
  claude: "54a71151ba88212c7996eba9db23c45f1e4f76f39fa46021e84c8d59b2224951",
  codex: "922ba73e610b0e13d165e3302b1b202da3bb06c9a61354c56d1e9d81faa00b4b",
  agy: "2beab2f2d06ceab9a39cb0fe33726e15928ce610ce56028d93acc1a3ac929c21",
};
