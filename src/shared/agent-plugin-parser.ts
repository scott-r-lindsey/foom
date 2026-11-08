import { AgentManifestError } from "./agent-manifest";
import type { ParsedAgentPlugin } from "./agent-manifest-v2";
import { manifestJson } from "./agent-manifest-json";
import { v2 } from "./agent-manifest-schema";
import { validateV2 } from "./agent-manifest-validation";
import { builtinAgent } from "./providers/catalog";

/** Offline only. No discovery, preparation, setup or launch capabilities. */
export function parseAgentManifest(
  source: string,
  origin: "config" | "bundled" = "config",
): ParsedAgentPlugin {
  // Reject unsupported versions before validating any version-specific fields.
  if (new TextEncoder().encode(source).length > 65536)
    throw new AgentManifestError("$", "too-large");
  let version: unknown;
  try {
    const raw: unknown = JSON.parse(source);
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw))
      version = Reflect.get(raw, "version");
  } catch {
    throw new AgentManifestError("$", "malformed-json");
  }
  if (version !== 2)
    throw new AgentManifestError(
      "$.version",
      version === 1
        ? "Agent manifest version 1 is no longer supported; use version 2 (see README.md)"
        : "Agent manifest version must be 2 (see README.md)",
    );
  const model = v2(manifestJson(source), "$");
  if (
    ["shell", "all", "constructor", "prototype", "__proto__"].includes(model.id) ||
    (origin === "config" && builtinAgent(model.id))
  )
    throw new AgentManifestError("$.id", "reserved-id");
  if (model.hostSetup?.script) {
    if (origin !== "bundled") throw new AgentManifestError("$.hostSetup.script", "bundled-only");
    let url: URL;
    try {
      url = new URL(model.hostSetup.script.url);
    } catch {
      throw new AgentManifestError("$.hostSetup.script.url", "https-only");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new AgentManifestError("$.hostSetup.script.url", "https-only");
  }
  validateV2(model);
  return { version: 2, model, templateDialect: "v2", helpMatching: "option-boundary" };
}
