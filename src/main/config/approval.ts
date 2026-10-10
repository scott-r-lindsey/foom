import type { ConfigSetting, ConfigSettings } from "../../shared/config";
import { CONFIG_SETTINGS } from "../../shared/config-settings";
import type { Settings } from "../../shared/setup";

export type EffectiveConfig = Pick<Settings, ConfigSetting>;

/** A file's values over the defaults: a missing key means the default, not "unchanged". */
export function effective(defaults: EffectiveConfig, values: ConfigSettings): EffectiveConfig {
  return { ...defaults, ...values };
}

export function configPart(settings: Settings): EffectiveConfig {
  const result: Partial<EffectiveConfig> = {};
  for (const key of CONFIG_SETTINGS) Object.assign(result, { [key]: settings[key] });
  return result as EffectiveConfig;
}

const AGENT_NAMES = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" } as const;

export interface Weakening {
  /** What the change would do, phrased to follow "An agent wants to". */
  action: string;
  /** The setting path and transition, such as `sound.alerts: on → off`. */
  detail: string;
}

/**
 * Changes that make Foom less able to say something needs the user. They wait for
 * approval; everything else (themes, sizes, turning things on) applies live.
 */
export function weakenings(before: EffectiveConfig, after: EffectiveConfig): Weakening[] {
  const result: Weakening[] = [];
  if (before.sound.alerts && !after.sound.alerts)
    result.push({ action: "turn off the needs-you sound", detail: "sound.alerts: on → off" });
  if (before.sound.alertVolume > 0 && after.sound.alertVolume <= 0)
    result.push({
      action: "set the needs-you volume to 0",
      detail: `sound.alertVolume: ${String(before.sound.alertVolume)} → 0`,
    });
  if (before.hooks && !after.hooks)
    result.push({ action: "turn hooks off", detail: "hooks: on → off" });
  for (const agent of ["claude", "codex", "agy"] as const)
    if (before.agents[agent] && !after.agents[agent])
      result.push({
        action: `turn off ${AGENT_NAMES[agent]}`,
        detail: `agents.${agent}: on → off`,
      });
  return result;
}

const LABELS: Record<ConfigSetting, string> = {
  colorMode: "Color mode",
  panelColor: "Panel color",
  interfaceTheme: "Interface theme",
  terminalTheme: "Terminal colors",
  interfaceScale: "Interface size",
  terminalFontSize: "Terminal font size",
  sound: "Sound",
  agents: "Agents",
  hooks: "Hooks",
};

/** Short commit subject naming what changed, such as "Terminal font size 15". */
export function describe(before: EffectiveConfig, after: EffectiveConfig): string {
  const changed = CONFIG_SETTINGS.filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  if (changed.length === 0) return "Settings";
  if (changed.length > 1)
    return `Settings: ${changed.map((key) => LABELS[key].toLowerCase()).join(", ")}`;
  const [key] = changed as [ConfigSetting];
  const value = after[key];
  if (typeof value === "boolean") return `${LABELS[key]} ${value ? "on" : "off"}`;
  if (typeof value === "number")
    return `${LABELS[key]} ${String(value)}${key === "interfaceScale" ? "%" : ""}`;
  if (typeof value === "string") return `${LABELS[key]} ${value}`;
  return LABELS[key];
}
