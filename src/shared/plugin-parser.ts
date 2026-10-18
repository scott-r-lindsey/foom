import { parseAgentManifest } from "./agent-plugin-parser";
import { parseForgeManifest } from "./forge-manifest";
import { fail } from "./agent-manifest-values";

/** Dispatch before kind-specific parsing; validate agent and forge versions independently. */
export function parsePluginManifest(source: string, origin: "bundled" | "config" = "config") {
  if (new TextEncoder().encode(source).length > 65536) fail("$", "too-large");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    fail("$", "malformed-json");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("$", "invalid-kind");
  if (!Object.hasOwn(value, "kind")) fail("$", "missing-key");
  const kind: unknown = Reflect.get(value, "kind");
  if (kind === "agent")
    return { kind: "agent" as const, plugin: parseAgentManifest(source, origin) };
  if (kind === "forge")
    return { kind: "forge" as const, plugin: parseForgeManifest(source, origin) };
  return fail("$", "invalid-kind");
}
