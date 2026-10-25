import { parseForgeEnablement, parseForgeHosts } from "./forge-settings";
import { DEFAULT_TERMINAL_FONT } from "../../shared/terminal-fonts";
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
import { validAgentId } from "../../shared/providers/catalog";
import type { LegacyAgentId } from "../../shared/agents";
import type { Settings, SettingsPatch } from "../../shared/setup";

const AGENTS: readonly LegacyAgentId[] = ["claude", "codex", "agy"];
/** Twice the theme folder limit, so renames settle before old entries are removed. */
const MAX_THEME_DIGESTS = 100;

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  setupComplete: false,
  checkForUpdates: true,
  agyPluginOfferAnswered: false,
  hooks: true,
  restoreSessions: true,
  showNewChildren: true,
  closeFinishedAgents: true,
  showNestedRepositoryNames: false,
  concurrentChildren: 4,
  recentRepositoryDays: 30,
  unreadChildMinutes: 5,
  autoRemoveMergedWorktrees: false,
  forges: Object.freeze({ github: true, gitlab: true }),
  forgeHosts: Object.freeze({ "github.com": "github", "gitlab.com": "gitlab" }),
  agents: Object.freeze({ claude: true, codex: true, agy: true }),
  agentArguments: EMPTY_AGENT_ARGUMENTS,
  agentBypassAcknowledged: Object.freeze({ claude: false, codex: false, agy: false }),
  worktreeLocation: "root",
  colorMode: "system",
  panelColor: "vivid",
  interfaceTheme: "follow",
  interfaceScale: 100,
  terminalFontSize: 14,
  terminalFont: DEFAULT_TERMINAL_FONT,
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
      (key === "setupComplete" ||
        key === "checkForUpdates" ||
        key === "agyPluginOfferAnswered" ||
        key === "autoRemoveMergedWorktrees" ||
        key === "showPullRequests" ||
        key === "showNestedRepositoryNames") &&
      typeof entry === "boolean"
    )
      patch[key] = entry;
    else if (key === "worktreeLocation" && (entry === "root" || entry === "adjacent"))
      patch.worktreeLocation = entry;
    else if (
      key === "agentBypassAcknowledged" &&
      record(entry) &&
      Object.keys(entry).length <= 100 &&
      AGENTS.every((id) => typeof entry[id] === "boolean") &&
      Object.entries(entry).every(
        ([id, enabled]) => validAgentId(id) && typeof enabled === "boolean",
      )
    )
      patch[key] = {
        ...Object.fromEntries(Object.entries(entry).map(([id, enabled]) => [id, enabled === true])),
        claude: entry["claude"] === true,
        codex: entry["codex"] === true,
        agy: entry["agy"] === true,
      };
    else if (
      key === "agentBypassIdentities" &&
      record(entry) &&
      Object.keys(entry).length <= 100 &&
      Object.entries(entry).every(
        ([id, identity]) =>
          validAgentId(id) && typeof identity === "string" && /^[a-f0-9]{64}$/u.test(identity),
      )
    )
      patch.agentBypassIdentities = Object.fromEntries(
        Object.entries(entry).map(([id, identity]) => [id, String(identity)]),
      );
    else if (
      key === "agentHooks" &&
      record(entry) &&
      Object.keys(entry).length <= 100 &&
      Object.entries(entry).every(
        ([id, enabled]) => validAgentId(id) && typeof enabled === "boolean",
      )
    )
      patch.agentHooks = Object.fromEntries(
        Object.entries(entry).map(([id, enabled]) => [id, enabled === true]),
      );
    else if (
      key === "unreadChildMinutes" &&
      typeof entry === "number" &&
      Number.isInteger(entry) &&
      entry >= 0 &&
      entry <= 1440
    )
      patch.unreadChildMinutes = entry;
    else if (key === "forges") patch.forges = parseForgeEnablement(entry);
    else if (key === "forgeHosts") patch.forgeHosts = parseForgeHosts(entry);
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
  private argumentsToMove: Settings["agentArguments"] | undefined;
  private digest: string | null = null;
  /** The config settings file this profile last applied, for Keep it on after a restart. */
  private text: string | null = null;
  /** Digests of the interface theme files this profile last applied, by config path. */
  private themeDigests: Readonly<Record<string, string>> = {};
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
        delete rest["codexNotifierAcknowledged"];
        delete rest["inference"];
        delete rest["inferenceTimeoutMs"];
        const kept =
          version === 2
            ? Object.fromEntries(Object.entries(rest).filter(([key]) => !isConfigSetting(key)))
            : rest;
        const recovered = { ...EMPTY_AGENT_ARGUMENTS };
        if (record(agentArguments)) {
          for (const agent of Object.keys(agentArguments)) {
            if (!validAgentId(agent)) continue;
            try {
              recovered[agent] = parseAgentArguments(agent, agentArguments[agent]);
            } catch {
              // A newer reserved-argument rule invalidates only this agent's defaults.
            }
          }
        }
        if (kept["restoreSessions"] !== undefined && typeof kept["restoreSessions"] !== "boolean")
          delete kept["restoreSessions"];
        const autoRemove = kept["autoRemoveMergedWorktrees"];
        const legacyAutoRemove = Array.isArray(autoRemove);
        if (legacyAutoRemove) {
          if (
            autoRemove.length > 1000 ||
            !autoRemove.every(
              (path: unknown) =>
                typeof path === "string" &&
                path.length <= 4096 &&
                !path.includes("\0") &&
                isAbsolute(path),
            )
          )
            throw new Error("Invalid settings");
          kept["autoRemoveMergedWorktrees"] = autoRemove.length > 0;
        }
        const parsed = parseSettingsPatch(kept);
        store.settings = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          sound: sound === undefined || version === 2 ? DEFAULT_SOUND : migrateSoundSettings(sound),
          agentArguments: recovered,
        };
        if (Object.values(recovered).some((args) => args.length > 0))
          store.argumentsToMove = recovered;
        if (version === 2) {
          store.migrated = true;
          const digest = state["configDigest"];
          store.digest =
            typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
          const text = state["configText"];
          store.text = typeof text === "string" && text.length <= 65536 ? text : null;
          const themes = state["themeDigests"];
          if (record(themes)) {
            const kept: Record<string, string> = {};
            for (const [file, value] of Object.entries(themes).slice(0, MAX_THEME_DIGESTS))
              if (
                /^themes\/[^/]{1,200}$/.test(file) &&
                typeof value === "string" &&
                /^[0-9a-f]{64}$/.test(value)
              )
                kept[file] = value;
            store.themeDigests = kept;
          }
        } else {
          store.legacy = Object.fromEntries(
            CONFIG_SETTINGS.filter(
              (key) =>
                key in parsed ||
                (key === "sound" && sound !== undefined) ||
                (key === "agentArguments" && store.argumentsToMove !== undefined),
            ).map((key) => [key, store.settings[key]]),
          );
        }
        migrated = legacy || legacyAutoRemove;
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
    return this.migrated
      ? this.argumentsToMove
        ? { agentArguments: this.argumentsToMove }
        : undefined
      : (this.legacy ?? {});
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
      this.argumentsToMove = undefined;
      this.digest = digest;
      this.settings = { ...this.settings, ...CONFIG_DEFAULTS, ...values };
    });
  }

  /** Values from a validated config file; the file, not the profile, stores them. */
  setConfig(values: ConfigSettings): void {
    this.settings = { ...this.settings, ...CONFIG_DEFAULTS, ...values };
  }

  /** Digest of the theme file this profile last applied: that theme's approval baseline. */
  themeDigest(file: string): string | null {
    return Object.hasOwn(this.themeDigests, file) ? (this.themeDigests[file] ?? null) : null;
  }

  async setThemeDigest(file: string, digest: string | null): Promise<void> {
    if (this.themeDigest(file) === digest) return;
    const next: Record<string, string> = Object.fromEntries(
      Object.entries(this.themeDigests).filter(([key]) => key !== file),
    );
    if (digest !== null) next[file] = digest;
    if (Object.keys(next).length > MAX_THEME_DIGESTS) return;
    await this.write(() => {
      this.themeDigests = next;
    });
  }

  /** The config settings file this profile last applied. */
  configText(): string | null {
    return this.text;
  }

  async setConfigText(text: string): Promise<void> {
    if (text === this.text || text.length > 65536) return;
    await this.write(() => {
      this.text = text;
    });
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
      if (profile.agentArguments)
        this.argumentsToMove = AGENTS.some((agent) => profile.agentArguments?.[agent].length)
          ? profile.agentArguments
          : undefined;
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
          text: this.text,
          themeDigests: this.themeDigests,
          writer: this.writer,
          legacy: this.legacy,
          argumentsToMove: this.argumentsToMove,
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
                  ? {
                      version: 2,
                      settings: {
                        ...profileOnly(this.settings),
                        ...(this.argumentsToMove ? { agentArguments: this.argumentsToMove } : {}),
                      },
                      configDigest: this.digest,
                      ...(this.text === null ? {} : { configText: this.text }),
                      ...(Object.keys(this.themeDigests).length
                        ? { themeDigests: this.themeDigests }
                        : {}),
                    }
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
          this.text = snapshot.text;
          this.themeDigests = snapshot.themeDigests;
          this.writer = snapshot.writer;
          this.legacy = snapshot.legacy;
          this.argumentsToMove = snapshot.argumentsToMove;
          throw error;
        }
      });
    this.pending = write;
    await write;
  }
}
