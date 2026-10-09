import { parseConfigSettings, CONFIG_SETTINGS } from "./config-settings";
import type { ConfigSettings } from "./config";
import { parseThemeFile } from "./theme-files";
import type { ThemeKind } from "./theme-file";
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
    "agentArguments",
    "agentBypassAcknowledged",
    "codexNotifierAcknowledged",
    "setupComplete",
    "codeFolder",
    "worktreeLocation",
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
      Object.assign(result, parseConfigSettings({ [key]: entry }));
    } catch {
      throw new ThemeValidationError(`$.${key}`, "invalid-value");
    }
  }
  return result;
}
export function validateConfigJson(text: string, expected?: "settings" | ThemeKind): void {
  const value = configJson(text);
  const kind = value["kind"];
  if (
    (expected && kind !== expected) ||
    (kind !== "settings" && kind !== "theme" && kind !== "terminal-theme")
  )
    throw new ThemeValidationError("$.kind", "invalid-value");
  if (kind === "settings") parseSettingsFile(text);
  else parseThemeFile(text, kind);
}
