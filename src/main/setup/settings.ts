import {
  EMPTY_AGENT_ARGUMENTS,
  parseAgentDefaults,
  parseAgentArguments,
} from "../agents/default-arguments";
import { isConfigSetting, parseConfigSettings } from "../../shared/config-settings";
import { DEFAULT_SOUND, migrateSoundSettings } from "../../shared/sounds";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { AgentId } from "../../shared/agents";
import type { Settings, SettingsPatch } from "../../shared/setup";

const AGENTS: readonly AgentId[] = ["claude", "codex", "agy"];

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  setupComplete: false,
  codexNotifierAcknowledged: false,
  hooks: true,
  agents: Object.freeze({ claude: true, codex: true, agy: true }),
  agentArguments: EMPTY_AGENT_ARGUMENTS,
  agentBypassAcknowledged: Object.freeze({ claude: false, codex: false, agy: false }),
  worktreeLocation: "root",
  colorMode: "system",
  panelColor: "vivid",
  interfaceTheme: "follow",
  interfaceScale: 100,
  terminalFontSize: 14,
  terminalTheme: "follow",
  sound: DEFAULT_SOUND,
  codeFolder: null,
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and copies an untrusted patch (from IPC or disk). Unknown fields are
 * rejected, so nothing the renderer invents is ever stored.
 */
export function parseSettingsPatch(value: unknown): SettingsPatch {
  if (!record(value)) throw new Error("Invalid settings");
  const patch: SettingsPatch = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      (key === "setupComplete" || key === "codexNotifierAcknowledged") &&
      typeof entry === "boolean"
    )
      patch[key] = entry;
    else if (key === "worktreeLocation" && (entry === "root" || entry === "adjacent"))
      patch.worktreeLocation = entry;
    else if (
      key === "agentBypassAcknowledged" &&
      record(entry) &&
      Object.keys(entry).length === AGENTS.length &&
      AGENTS.every((id) => typeof entry[id] === "boolean")
    )
      patch[key] = {
        claude: entry["claude"] === true,
        codex: entry["codex"] === true,
        agy: entry["agy"] === true,
      };
    else if (key === "agentArguments") patch.agentArguments = parseAgentDefaults(entry);
    else if (isConfigSetting(key)) Object.assign(patch, parseConfigSettings({ [key]: entry }));
    else if (
      key === "codeFolder" &&
      (entry === null ||
        (typeof entry === "string" &&
          entry.length <= 4096 &&
          !entry.includes("\0") &&
          isAbsolute(entry)))
    )
      patch.codeFolder = entry;
    else throw new Error("Invalid settings");
  }
  return patch;
}

/** Versioned `settings.json` in user data, written atomically and one write at a time. */
export class SettingsStore {
  private settings: Settings = DEFAULT_SETTINGS;
  private pending: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string) {}

  /** Missing, corrupt or unsupported state starts from defaults, so setup runs again. */
  static async open(userData: string): Promise<SettingsStore> {
    // Remove ciphertext without decrypting it or depending on OS key storage.
    for (const provider of ["anthropic", "openai", "google"])
      await rm(join(userData, `inference-${provider}.key`), { force: true });
    const store = new SettingsStore(join(userData, "settings.json"));
    let migrated = false;
    try {
      const state: unknown = JSON.parse(await readFile(store.file, "utf8"));
      if (record(state) && state["version"] === 1 && record(state["settings"])) {
        const { agentArguments, sound, ...rest } = state["settings"];
        const legacy = "inference" in rest || "inferenceTimeoutMs" in rest;
        delete rest["inference"];
        delete rest["inferenceTimeoutMs"];
        const recovered = { ...EMPTY_AGENT_ARGUMENTS };
        if (record(agentArguments)) {
          for (const agent of AGENTS) {
            try {
              recovered[agent] = parseAgentArguments(agent, agentArguments[agent]);
            } catch {
              // A newer reserved-argument rule invalidates only this agent's defaults.
            }
          }
        }
        store.settings = {
          ...DEFAULT_SETTINGS,
          ...parseSettingsPatch(rest),
          sound: sound === undefined ? DEFAULT_SOUND : migrateSoundSettings(sound),
          agentArguments: recovered,
        };
        migrated = legacy;
      }
    } catch {
      // Defaults.
    }
    if (migrated) await store.update({});
    return store;
  }

  get(): Settings {
    return this.settings;
  }

  /** Resolves once the new settings are on disk; a failed write leaves them unchanged. */
  async update(patch: SettingsPatch): Promise<Settings> {
    const write = this.pending
      .catch(() => undefined)
      .then(async () => {
        const next = { ...this.settings, ...patch };
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify({ version: 1, settings: next }), {
            flag: "wx",
            mode: 0o600,
          });
          await rename(temporary, this.file);
        } finally {
          await rm(temporary, { force: true });
        }
        this.settings = next;
      });
    this.pending = write;
    await write;
    return this.settings;
  }
}
