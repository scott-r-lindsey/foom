import {
  EMPTY_AGENT_ARGUMENTS,
  parseAgentDefaults,
  parseAgentArguments,
} from "../agents/default-arguments";
import {
  CONFIG_SETTINGS,
  isConfigSetting,
  parseConfigSettings,
} from "../../shared/config-settings";
import type { ConfigSettings } from "../../shared/config";
import { DEFAULT_SOUND, migrateSoundSettings } from "../../shared/sounds";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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

/** Writes the agent-editable part to `~/.foom/config/settings.json` once attached. */
export type ConfigWriter = (patch: ConfigSettings) => Promise<void>;

const CONFIG_DEFAULTS: ConfigSettings = Object.fromEntries(
  CONFIG_SETTINGS.map((key) => [key, DEFAULT_SETTINGS[key]]),
);

function profileOnly(settings: Settings): Partial<Settings> {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !isConfigSetting(key)));
}

/**
 * Versioned `settings.json` in user data, written atomically and one write at a time.
 * Version 1 holds every setting. Once the Foom config folder is attached, version 2
 * holds only profile settings plus the digest of the config file Foom last applied.
 */
export class SettingsStore {
  private settings: Settings = DEFAULT_SETTINGS;
  private pending: Promise<void> = Promise.resolve();
  private legacy: ConfigSettings | undefined;
  private migrated = false;
  private digest: string | null = null;
  private writer: ConfigWriter | undefined;

  private constructor(private readonly file: string) {}

  /** Missing, corrupt or unsupported state starts from defaults, so setup runs again. */
  static async open(userData: string): Promise<SettingsStore> {
    // Remove ciphertext, including interrupted atomic writes, without decrypting it.
    const files = await readdir(userData).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    const temporaryKey =
      /^inference-(?:anthropic|openai|google)\.key\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
    const keys = [
      ...["anthropic", "openai", "google"].map((provider) => `inference-${provider}.key`),
      ...files.filter((file) => temporaryKey.test(file)),
    ];
    for (const file of keys) await rm(join(userData, file), { force: true });
    const store = new SettingsStore(join(userData, "settings.json"));
    let migrated = false;
    try {
      const state: unknown = JSON.parse(await readFile(store.file, "utf8"));
      const version = record(state) ? state["version"] : undefined;
      if (record(state) && (version === 1 || version === 2) && record(state["settings"])) {
        const { agentArguments, sound, ...rest } = state["settings"];
        const legacy = "inference" in rest || "inferenceTimeoutMs" in rest;
        delete rest["inference"];
        delete rest["inferenceTimeoutMs"];
        const kept =
          version === 2
            ? Object.fromEntries(Object.entries(rest).filter(([key]) => !isConfigSetting(key)))
            : rest;
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
        const parsed = parseSettingsPatch(kept);
        store.settings = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          sound: sound === undefined || version === 2 ? DEFAULT_SOUND : migrateSoundSettings(sound),
          agentArguments: recovered,
        };
        if (version === 2) {
          store.migrated = true;
          const digest = state["configDigest"];
          store.digest =
            typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
        } else {
          store.legacy = Object.fromEntries(
            CONFIG_SETTINGS.filter(
              (key) => key in parsed || (key === "sound" && sound !== undefined),
            ).map((key) => [key, store.settings[key]]),
          );
        }
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

  /** Agent-editable values a version 1 profile still holds; undefined once migrated. */
  legacyConfig(): ConfigSettings | undefined {
    return this.migrated ? undefined : (this.legacy ?? {});
  }

  /** Digest of the config file this profile last applied: the approval baseline. */
  configDigest(): string | null {
    return this.digest;
  }

  /**
   * Hands the agent-editable settings to the config folder. The same write removes
   * them from the profile, so the migration happens exactly once.
   */
  async attachConfig(
    writer: ConfigWriter,
    values: ConfigSettings,
    digest: string | null,
  ): Promise<void> {
    await this.write(() => {
      this.writer = writer;
      this.migrated = true;
      this.legacy = undefined;
      this.digest = digest;
      this.settings = { ...this.settings, ...CONFIG_DEFAULTS, ...values };
    });
  }

  /** Values from a validated config file; the file, not the profile, stores them. */
  setConfig(values: ConfigSettings): void {
    this.settings = { ...this.settings, ...CONFIG_DEFAULTS, ...values };
  }

  async setConfigDigest(digest: string): Promise<void> {
    if (digest === this.digest) return;
    await this.write(() => {
      this.digest = digest;
    });
  }

  /** Resolves once the new settings are on disk; a failed write leaves them unchanged. */
  async update(patch: SettingsPatch): Promise<Settings> {
    const config: ConfigSettings = {};
    const profile: SettingsPatch = {};
    for (const [key, value] of Object.entries(patch))
      Object.assign(this.writer && isConfigSetting(key) ? config : profile, { [key]: value });
    if (this.writer && Object.keys(config).length) await this.writer(config);
    if (Object.keys(config).length && !Object.keys(profile).length) return this.settings;
    await this.write(() => {
      this.settings = { ...this.settings, ...profile };
    });
    return this.settings;
  }

  private async write(change: () => void): Promise<void> {
    const write = this.pending
      .catch(() => undefined)
      .then(async () => {
        const snapshot = {
          settings: this.settings,
          migrated: this.migrated,
          digest: this.digest,
          writer: this.writer,
          legacy: this.legacy,
        };
        change();
        try {
          await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
          const temporary = `${this.file}.${randomUUID()}.tmp`;
          try {
            await writeFile(
              temporary,
              JSON.stringify(
                this.migrated
                  ? { version: 2, settings: profileOnly(this.settings), configDigest: this.digest }
                  : { version: 1, settings: this.settings },
              ),
              { flag: "wx", mode: 0o600 },
            );
            await rename(temporary, this.file);
          } finally {
            await rm(temporary, { force: true });
          }
        } catch (error) {
          this.settings = snapshot.settings;
          this.migrated = snapshot.migrated;
          this.digest = snapshot.digest;
          this.writer = snapshot.writer;
          this.legacy = snapshot.legacy;
          throw error;
        }
      });
    this.pending = write;
    await write;
  }
}
