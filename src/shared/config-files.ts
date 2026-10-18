import { AgentManifestError } from "./agent-manifest";
import { parsePluginManifest } from "./plugin-parser";
import { migrateSoundSettings } from "./sounds";
import { AgentArgumentsError } from "./providers/arguments";
import { parseConfigSettings, CONFIG_SETTINGS } from "./config-settings";
import type { ConfigSettings } from "./config";
import { parseThemeFile } from "./theme-files";
import type { ThemeDiagnostic, ThemeKind } from "./theme-file";
import { ThemeValidationError, themeKeys, themeRecord } from "./theme-validation";
export function configJson(text: string): Record<string, unknown> {
  if (new TextEncoder().encode(text).length > 65536)
    throw new ThemeValidationError("$", "too-large");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ThemeValidationError("$", "malformed-json");
  }
  return themeRecord(value, "$");
}
export function parseSettingsFile(text: string): ConfigSettings {
  const value = configJson(text);
  // Known excluded fields receive a stable, useful path, without echoing arbitrary keys.
  for (const key of [
    "agentBypassAcknowledged",
    "codexNotifierAcknowledged",
    "setupComplete",
    "codeFolder",
    "worktreeLocation",
    "environment",
  ])
    if (Object.hasOwn(value, key)) throw new ThemeValidationError(`$.${key}`, "unknown-key");
  themeKeys(value, ["kind"], "$", CONFIG_SETTINGS);
  if (value["kind"] !== "settings") throw new ThemeValidationError("$.kind", "invalid-value");
  const settings = { ...value };
  delete settings["kind"];
  for (const key of ["interfaceTheme", "terminalTheme"])
    if (Object.hasOwn(settings, key) && typeof settings[key] !== "string")
      throw new ThemeValidationError(`$.${key}`, "invalid-value");
  const result: ConfigSettings = {};
  for (const [key, entry] of Object.entries(settings)) {
    try {
      Object.assign(
        result,
        parseConfigSettings({ [key]: key === "sound" ? migrateSoundSettings(entry) : entry }),
      );
    } catch (error) {
      throw new ThemeValidationError(
        `$.${key}`,
        "invalid-value",
        error instanceof AgentArgumentsError ? error.message : undefined,
      );
    }
  }
  return result;
}
export function validateConfigJson(
  text: string,
  expected?: "settings" | "agent" | "forge" | ThemeKind,
): readonly ThemeDiagnostic[] {
  const value = configJson(text);
  const kind = value["kind"] ?? (value["version"] !== undefined ? "theme" : undefined);
  if (
    (expected && kind !== expected) ||
    (kind !== "agent" &&
      kind !== "forge" &&
      kind !== "settings" &&
      kind !== "theme" &&
      kind !== "terminal-theme")
  )
    throw new ThemeValidationError("$.kind", "invalid-value");
  if (kind === "agent" || kind === "forge") {
    try {
      parsePluginManifest(text);
    } catch (error) {
      if (error instanceof AgentManifestError)
        throw new ThemeValidationError(error.path, "invalid-value", error.reason);
      throw error;
    }
  } else if (kind === "settings") parseSettingsFile(text);
  else {
    const parsed = parseThemeFile(text, kind);
    return parsed.kind === "theme" ? (parsed.warnings ?? []) : [];
  }
  return [];
}
