import { createHash } from "node:crypto";
import opencode from "../../../shared/bundled-agents/opencode.json";
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
    "68bcf38cd5432680ce3d293b6a453129aa8b59dafd98127b5d51e0a085973dd5",
  ),
  bundledProvider(
    codex,
    "codex",
    "e5afbef90ce00779271cbebb22f0571f76446d16ef355674d7ebd8e9a3061c9d",
  ),
  bundledProvider(agy, "agy", "db7f8b59d03461d2d7e7d1d1af8f54419ba76e9f625b3b083e5b83c15d8fb668"),
  bundledProvider(
    opencode,
    "opencode",
    "c732911ab07e95876cf273d9a7cd1aa0a889a8a90c5078fb1884665ee8dc6508",
  ),
];

/** Build-owned migrations: retain old config rows, but require an explicit bundled resume. */
export const formerConfigAgentIds: readonly string[] = ["opencode"];
