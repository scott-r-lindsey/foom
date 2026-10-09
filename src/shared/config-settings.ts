import type { ConfigSettings, ConfigSetting } from "./config";
import { parseInterfaceTheme } from "./interface-themes";
import { parseTerminalThemeChoice } from "./terminal-themes";
import { parseSoundSettings } from "./sounds";
import { ThemeValidationError, themeRecord } from "./theme-validation";
export const SCALES: readonly number[] = [80, 90, 100, 110, 120, 130, 140, 150];
export const CONFIG_SETTINGS = [
  "colorMode",
  "panelColor",
  "interfaceTheme",
  "interfaceScale",
  "terminalFontSize",
  "terminalTheme",
  "sound",
  "agents",
  "hooks",
] as const;
export function isConfigSetting(key: string): key is ConfigSetting {
  return CONFIG_SETTINGS.some((allowed) => allowed === key);
}
/** Shared value rules for main's settings patches and the offline settings file. */
export function parseConfigSettings(value: unknown): ConfigSettings {
  const data = themeRecord(value, "$");
  const result: ConfigSettings = {};
  for (const [key, entry] of Object.entries(data)) {
    if (!isConfigSetting(key)) throw new ThemeValidationError("$", "unknown-key");
    if (key === "interfaceTheme") result.interfaceTheme = parseInterfaceTheme(entry);
    else if (key === "terminalTheme") result.terminalTheme = parseTerminalThemeChoice(entry);
    else if (key === "sound") result.sound = parseSoundSettings(entry);
    else if (key === "hooks" && typeof entry === "boolean") result.hooks = entry;
    else if (key === "agents") {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        throw new Error("Invalid settings");
      const agents = themeRecord(entry, "$.agents");
      if (
        Object.keys(agents).length !== 3 ||
        !["claude", "codex", "agy"].every((id) => typeof agents[id] === "boolean")
      )
        throw new Error("Invalid settings");
      result.agents = {
        claude: agents["claude"] === true,
        codex: agents["codex"] === true,
        agy: agents["agy"] === true,
      };
    } else if (key === "colorMode" && (entry === "system" || entry === "light" || entry === "dark"))
      result.colorMode = entry;
    else if (key === "panelColor" && (entry === "vivid" || entry === "subtle" || entry === "plain"))
      result.panelColor = entry;
    else if (key === "interfaceScale" && typeof entry === "number" && SCALES.includes(entry))
      result.interfaceScale = entry;
    else if (
      key === "terminalFontSize" &&
      typeof entry === "number" &&
      Number.isInteger(entry) &&
      entry >= 10 &&
      entry <= 32
    )
      result.terminalFontSize = entry;
    else throw new Error("Invalid settings");
  }
  return result;
}
