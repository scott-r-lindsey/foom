import { isDeepStrictEqual } from "node:util";
import { hasBypassArgument } from "../../shared/providers/arguments";
import type { AgentId } from "../../shared/agents";
import type { DialogContent } from "../../shared/confirmation";
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

const AGENT_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  agy: "Antigravity",
};

export interface Weakening {
  field:
    | readonly ["hooks" | "restoreSessions" | "interfaceTheme" | "agentArguments"]
    | readonly ["sound", keyof EffectiveConfig["sound"]]
    | readonly ["agents", AgentId];
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
  if (!before.restoreSessions && after.restoreSessions)
    result.push({
      field: ["restoreSessions"],
      action: "restore sessions on launch",
      detail: "restoreSessions: off → on",
    });
  if (before.sound.alerts && !after.sound.alerts)
    result.push({
      field: ["sound", "alerts"],
      action: "turn off the needs-you sound",
      detail: "sound.alerts: on → off",
    });
  if (before.sound.alertVolume > 0 && after.sound.alertVolume <= 0)
    result.push({
      field: ["sound", "alertVolume"],
      action: "set the needs-you volume to 0",
      detail: `sound.alertVolume: ${String(before.sound.alertVolume)} → 0`,
    });
  if (before.sound.volume > 0 && after.sound.volume <= 0)
    result.push({
      field: ["sound", "volume"],
      action: "set the master volume to 0",
      detail: `sound.volume: ${String(before.sound.volume)} → 0`,
    });
  if (!before.sound.muted && after.sound.muted)
    result.push({
      field: ["sound", "muted"],
      action: "mute sounds",
      detail: "sound.muted: off → on",
    });
  if (before.hooks && !after.hooks)
    result.push({ field: ["hooks"], action: "turn hooks off", detail: "hooks: on → off" });
  for (const agent of new Set([...Object.keys(before.agents), ...Object.keys(after.agents)]))
    if (before.agents[agent] === true && after.agents[agent] !== true)
      result.push({
        field: ["agents", agent],
        action: `turn off ${AGENT_NAMES[agent] ?? agent}`,
        detail: `agents.${agent}: on → off`,
      });
  return result;
}

const LABELS: Record<ConfigSetting, string> = {
  panelColor: "Panel color",
  interfaceTheme: "Interface theme",
  terminalTheme: "Terminal colors",
  interfaceScale: "Interface size",
  terminalFontSize: "Terminal font size",
  terminalFont: "Terminal font",
  sound: "Sound",
  agents: "Agents",
  defaultAgent: "Default agent",
  agentArguments: "Agent launch arguments",
  hooks: "Hooks",
  restoreSessions: "Restore sessions on launch",
  showNewChildren: "Show new children on the board",
  closeFinishedAgents: "Close finished agents",
  concurrentChildren: "Concurrent children per orchestrator",
  recentRepositoryDays: "Recent repository days",
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

/** Every argument change requires consent, including removal and apparently harmless flags. */
export function argumentChanges(before: EffectiveConfig, after: EffectiveConfig): Weakening[] {
  return [...new Set([...Object.keys(before.agentArguments), ...Object.keys(after.agentArguments)])]
    .filter(
      (agent) =>
        JSON.stringify(before.agentArguments[agent] ?? []) !==
        JSON.stringify(after.agentArguments[agent] ?? []),
    )
    .map((agent) => ({
      field: ["agentArguments"],
      action: `change ${AGENT_NAMES[agent] ?? agent} launch arguments`,
      detail: `agentArguments.${agent}`,
    }));
}

/** Keep safe file edits and restore only fields that require approval. */
export function retainApproved(
  defaults: EffectiveConfig,
  baseline: ConfigSettings,
  proposal: ConfigSettings,
  held: readonly Weakening[],
): ConfigSettings {
  const approved = { ...proposal };
  const before = effective(defaults, baseline);
  const restored = new Set<ConfigSetting>();
  for (const {
    field: [setting, key],
  } of held) {
    restored.add(setting);
    if (setting === "sound") {
      approved.sound = { ...(approved.sound ?? defaults.sound), [key]: before.sound[key] };
    } else if (setting === "agents") {
      const entries = { ...(approved[setting] ?? defaults[setting]) };
      if (Object.hasOwn(before[setting], key))
        Object.assign(entries, { [key]: before[setting][key] });
      else Reflect.deleteProperty(entries, key);
      Object.assign(approved, { [setting]: entries });
    } else if (baseline[setting] === undefined) {
      Reflect.deleteProperty(approved, setting);
    } else {
      Object.assign(approved, { [setting]: baseline[setting] });
    }
  }
  for (const setting of ["sound", "agents"] as const) {
    if (
      restored.has(setting) &&
      baseline[setting] === undefined &&
      isDeepStrictEqual(approved[setting], defaults[setting])
    )
      Reflect.deleteProperty(approved, setting);
  }
  return approved;
}

/** Preserve both argv entries for recognized bypass options with separate values. */
function bypassArguments(agent: AgentId, args: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const pair = args.slice(index, index + 2);
    if (hasBypassArgument(agent, [arg])) found.push(arg);
    else if (
      [
        "--permission-mode",
        "--ask-for-approval",
        "-a",
        "--sandbox",
        "-s",
        "-c",
        "--config",
      ].includes(arg) &&
      pair.length === 2 &&
      hasBypassArgument(agent, pair)
    ) {
      found.push(...pair);
      index += 1;
    }
  }
  return found;
}

/** Literal argument lines stay in the trusted dialog, never the board's status metadata. */
export function argumentDisclosure(before: EffectiveConfig, after: EffectiveConfig): DialogContent {
  const agents = [
    ...new Set([...Object.keys(before.agentArguments), ...Object.keys(after.agentArguments)]),
  ].filter(
    (agent) =>
      JSON.stringify(before.agentArguments[agent] ?? []) !==
      JSON.stringify(after.agentArguments[agent] ?? []),
  );
  return {
    title: "Allow agent launch arguments?",
    glyph: "shield",
    subject: "Future launches from Foom",
    accept: "Allow",
    sections: agents.flatMap((agent) => [
      {
        label: `${AGENT_NAMES[agent] ?? agent} before`,
        arguments: true,
        items: (before.agentArguments[agent] ?? []).length
          ? (before.agentArguments[agent] ?? [])
          : ["(no arguments)"],
      },
      {
        label: `${AGENT_NAMES[agent] ?? agent} after`,
        arguments: true,
        items: (after.agentArguments[agent] ?? []).length
          ? (after.agentArguments[agent] ?? [])
          : ["(no arguments)"],
      },
      ...(hasBypassArgument(agent, after.agentArguments[agent] ?? [])
        ? [
            {
              label: `${AGENT_NAMES[agent] ?? agent} bypass`,
              arguments: true,
              items: bypassArguments(agent, after.agentArguments[agent] ?? []),
            },
          ]
        : []),
    ]),
    detail:
      "These arguments apply to new, resumed and restored sessions. A worktree is not a sandbox. With bypass arguments, the agent can act as you anywhere on the machine.",
  };
}
