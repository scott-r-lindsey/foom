import { hasBypassArgument } from "../../shared/agent-arguments";
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
    result.push({ action: "restore sessions on launch", detail: "restoreSessions: off → on" });
  if (before.sound.alerts && !after.sound.alerts)
    result.push({ action: "turn off the needs-you sound", detail: "sound.alerts: on → off" });
  if (before.sound.alertVolume > 0 && after.sound.alertVolume <= 0)
    result.push({
      action: "set the needs-you volume to 0",
      detail: `sound.alertVolume: ${String(before.sound.alertVolume)} → 0`,
    });
  if (before.sound.volume > 0 && after.sound.volume <= 0)
    result.push({
      action: "set the master volume to 0",
      detail: `sound.volume: ${String(before.sound.volume)} → 0`,
    });
  if (!before.sound.muted && after.sound.muted)
    result.push({ action: "mute sounds", detail: "sound.muted: off → on" });
  if (before.hooks && !after.hooks)
    result.push({ action: "turn hooks off", detail: "hooks: on → off" });
  for (const agent of new Set([...Object.keys(before.agents), ...Object.keys(after.agents)]))
    if (before.agents[agent] !== false && after.agents[agent] === false)
      result.push({
        action: `turn off ${AGENT_NAMES[agent] ?? agent}`,
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
  terminalFont: "Terminal font",
  sound: "Sound",
  agents: "Agents",
  agentArguments: "Agent launch arguments",
  hooks: "Hooks",
  restoreSessions: "Restore sessions on launch",
  concurrentChildren: "Concurrent children per orchestrator",
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
        JSON.stringify(before.agentArguments[agent]) !==
        JSON.stringify(after.agentArguments[agent]),
    )
    .map((agent) => ({
      action: `change ${AGENT_NAMES[agent] ?? agent} launch arguments`,
      detail: `agentArguments.${agent}`,
    }));
}

/** Preserve both argv entries for recognized bypass options with separate values. */
function bypassArguments(agent: AgentId, args: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const pair = args.slice(index, index + 2);
    if (
      ["--permission-mode", "--sandbox", "-s", "-c", "--config"].includes(arg) &&
      pair.length === 2 &&
      hasBypassArgument(agent, pair)
    ) {
      found.push(...pair);
      index += 1;
    } else if (hasBypassArgument(agent, [arg])) found.push(arg);
  }
  return found;
}

/** Literal argument lines stay in the trusted dialog, never the board's status metadata. */
export function argumentDisclosure(before: EffectiveConfig, after: EffectiveConfig): DialogContent {
  const agents = [
    ...new Set([...Object.keys(before.agentArguments), ...Object.keys(after.agentArguments)]),
  ].filter(
    (agent) =>
      JSON.stringify(before.agentArguments[agent]) !== JSON.stringify(after.agentArguments[agent]),
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
