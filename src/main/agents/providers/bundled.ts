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
    "c7c421400bd67cc157bd88acb2c2fbe6000221e6273704c8b90979f701a75eec",
  ),
  bundledProvider(
    codex,
    "codex",
    "2a38aaf111496fec47c8ce02a073553a15ad43f2495bcc69c69b78dcdf1c2385",
  ),
  bundledProvider(agy, "agy", "f5ca8ccb1d4c1b41280cf58d231fc672ad0c857a050e0e0e906d2f132942b53d"),
  bundledProvider(
    copilot,
    "copilot",
    "8bfd1677eb93babd8a323fd6b7b59ad06d76bd370a567d9532fa0acf82add9e7",
  ),
  bundledProvider(
    opencode,
    "opencode",
    "b99c2c6de262d3fe6128f1bb0fe1f1021c012171413bb906e6529b139984ca5e",
  ),
  bundledProvider(pi, "pi", "ae24e1b71a95436084cee548fda9c3babb5d873217e5bd9d6223a44a0d00ad80"),
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
