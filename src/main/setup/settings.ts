import { isDeepStrictEqual } from "node:util";
import type { ThemeApproval } from "../../shared/theme-bitmap";
import { parseAgentDefaults as parseStoredAgentDefaults } from "../../shared/providers/arguments";
import { agentPermissionLevel } from "../../shared/agent-permission-arguments";
import { hostAlias } from "../../shared/registered-hosts";
import type { RegisteredHost } from "../../shared/registered-hosts.d";
import type { AgentPermissionSettings } from "../../shared/agent-permissions";
import { settingsChanged } from "../data/settings-changes";
import { registeredHosts } from "../../shared/registered-hosts";
import { parseForgeEnablement, parseForgeHosts } from "./forge-settings";
import { legacyBypassIdentities } from "../agents/providers/bundled";
import { DEFAULT_TERMINAL_FONT } from "../../shared/terminal-fonts";
import {
  EMPTY_AGENT_ARGUMENTS,
  parseAgentDefaults,
  parseAgentArguments,
} from "../agents/default-arguments";
import {
  migrateAppearanceSettings,
  CONFIG_SETTINGS,
  isConfigSetting,
  parseConfigSettings,
} from "../../shared/config-settings";
import type { ConfigSettings } from "../../shared/config";
import { DEFAULT_SOUND, migrateSoundSettings } from "../../shared/sounds";
import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import {
  link,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { validAgentId } from "../../shared/providers/catalog";
import type { Settings, SettingsPatch } from "../../shared/setup";

/** Twice the theme folder limit, so renames settle before old entries are removed. */
const MAX_THEME_DIGESTS = 100;
const SUPERSEDED_PROFILE_WRITE = new Error("Superseded profile write");
const hostRegistrationIdentities = new WeakMap<RegisteredHost, symbol>();

/** Identity of a registered destination across display-only profile updates. */
export function hostRegistrationIdentity(registration: RegisteredHost): symbol {
  const current = hostRegistrationIdentities.get(registration);
  if (current) return current;
  const identity = Symbol();
  hostRegistrationIdentities.set(registration, identity);
  return identity;
}

type RegisteredHostsPatch = {
  registeredHosts: NonNullable<Settings["registeredHosts"]>;
} & { [Key in Exclude<keyof SettingsPatch, "registeredHosts">]?: never };

type AgentPermissionsPatch = {
  agentPermissions: NonNullable<Settings["agentPermissions"]>;
} & { [Key in Exclude<keyof SettingsPatch, "agentPermissions">]?: never };

function freezeSettings<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeSettings(child);
  }
  return value;
}

const sha256 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);

export function parseThemeApproval(value: unknown): ThemeApproval | undefined {
  if (sha256(value)) return value;
  if (
    !record(value) ||
    Object.keys(value).length !== 4 ||
    value["decoded"] !== true ||
    !sha256(value["digest"]) ||
    !sha256(value["jsonDigest"]) ||
    !record(value["sources"])
  )
    return undefined;
  // Migrate the approved JSON independently of the old artwork digests.
  const sources = value["sources"];
  const legacy = ["board", "gutter", "sidebar"];
  if (!Object.keys(sources).every((slot) => legacy.includes(slot) && sha256(sources[slot])))
    return undefined;
  return value["jsonDigest"];
}

export const DEFAULT_SETTINGS: Settings = freezeSettings({
  setupComplete: false,
  checkForUpdates: true,
  agyPluginOfferAnswered: false,
  hooks: true,
  restoreSessions: true,
  showNewChildren: true,
  closeFinishedAgents: true,
  wakeOrchestrator: false,
  wakeIntervalMinutes: 3,
  showNestedRepositoryNames: false,
  middleClickPaste: false,
  copyOnSelect: false,
  terminalClipboardWrites: false,
  concurrentChildren: 4,
  defaultAgent: null,
  recentRepositoryDays: 30,
  unreadChildMinutes: 5,
  autoRemoveMergedWorktrees: false,
  forges: Object.freeze({ github: true, gitlab: true }),
  forgeHosts: Object.freeze({ "github.com": "github", "gitlab.com": "gitlab" }),
  agents: Object.freeze({}),
  agentArguments: EMPTY_AGENT_ARGUMENTS,
  agentBypassAcknowledged: Object.freeze({}),
  worktreeLocation: "root",
  panelColor: "vivid",
  interfaceTheme: "follow",
  interfaceScale: 100,
  terminalFontSize: 14,
  terminalFont: DEFAULT_TERMINAL_FONT,
  terminalTheme: "follow",
  sound: structuredClone(DEFAULT_SOUND),
  codeFolder: null,
  sourceDirectory: null,
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agentPermissions(value: unknown): value is AgentPermissionSettings {
  return (
    record(value) &&
    Object.keys(value).length <= 34 &&
    Object.entries(value).every(
      ([scope, choices]) =>
        (scope === "global" ||
          scope === "local" ||
          (scope.startsWith("host:") && hostAlias(scope.slice(5)))) &&
        record(choices) &&
        Object.keys(choices).length <= 100 &&
        Object.entries(choices).every(
          ([agent, choice]) =>
            validAgentId(agent) &&
            (choice === null ||
              (record(choice) &&
                Object.keys(choice).every((key) => key === "level" || key === "identity") &&
                agentPermissionLevel(choice["level"]) &&
                (choice["identity"] === undefined ||
                  (choice["level"] === "full" &&
                    typeof choice["identity"] === "string" &&
                    /^[a-f0-9]{64}$/u.test(choice["identity"]))))),
        ),
    )
  );
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
        key === "wakeOrchestrator" ||
        key === "agyPluginOfferAnswered" ||
        key === "autoRemoveMergedWorktrees" ||
        key === "showPullRequests" ||
        key === "showNestedRepositoryNames" ||
        key === "middleClickPaste" ||
        key === "copyOnSelect" ||
        key === "terminalClipboardWrites") &&
      typeof entry === "boolean"
    )
      patch[key] = entry;
    else if (key === "worktreeLocation" && (entry === "root" || entry === "adjacent"))
      patch.worktreeLocation = entry;
    else if (
      key === "agentBypassAcknowledged" &&
      record(entry) &&
      Object.keys(entry).length <= 100 &&
      Object.entries(entry).every(
        ([id, enabled]) => validAgentId(id) && typeof enabled === "boolean",
      )
    )
      patch[key] = Object.fromEntries(
        Object.entries(entry).map(([id, enabled]) => [id, enabled === true]),
      );
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
    else if (
      key === "wakeIntervalMinutes" &&
      typeof entry === "number" &&
      Number.isInteger(entry) &&
      entry >= 1 &&
      entry <= 1440
    )
      patch.wakeIntervalMinutes = entry;
    else if (key === "registeredHosts" && registeredHosts(entry))
      patch.registeredHosts = entry.map((host) => ({ ...host }));
    else if (key === "forges") patch.forges = parseForgeEnablement(entry);
    else if (key === "forgeHosts") patch.forgeHosts = parseForgeHosts(entry);
    else if (key === "agentPermissions" && agentPermissions(entry))
      patch.agentPermissions = structuredClone(entry);
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
    else if (
      key === "sourceDirectory" &&
      (entry === null ||
        (typeof entry === "string" &&
          entry.length <= 4096 &&
          !/\p{Cc}/u.test(entry) &&
          (isAbsolute(entry) || entry.startsWith("~/"))))
    )
      patch.sourceDirectory = entry;
    else throw new Error("Invalid settings");
  }
  return patch;
}

/** Writes the agent-editable part to `~/.foom/config/settings.json` once attached. */
export type ConfigWriter = (patch: ConfigSettings, themeDigest?: string) => Promise<void>;

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
  private committedSettings: Settings = DEFAULT_SETTINGS;
  private remoteProfile = randomUUID().replaceAll("-", "");
  profileTag(): string {
    return this.remoteProfile;
  }
  private pending: Promise<void> = Promise.resolve();
  private legacy: ConfigSettings | undefined;
  private migrated = false;
  private argumentsToMove: Settings["agentArguments"] | undefined;
  private digest: string | null = null;
  /** The config settings file this profile last applied, for Keep it on after a restart. */
  private text: string | null = null;
  /** Digests of the interface theme files this profile last applied, by config path. */
  private themeDigests: Readonly<Record<string, ThemeApproval>> = {};
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
    let hasRemoteProfile = false;
    let backup: string | undefined;
    try {
      const state: unknown = JSON.parse(await readFile(store.file, "utf8"));
      const version = record(state) ? state["version"] : undefined;
      if (
        record(state) &&
        typeof state["remoteProfile"] === "string" &&
        /^[a-f0-9]{32}$/u.test(state["remoteProfile"])
      ) {
        store.remoteProfile = state["remoteProfile"];
        hasRemoteProfile = true;
      }
      if (record(state) && (version === 1 || version === 2) && record(state["settings"])) {
        const { agentArguments, sound, ...rest } = migrateAppearanceSettings(state["settings"]);
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
              recovered[agent] = [];
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
          sound:
            sound === undefined || version === 2
              ? DEFAULT_SETTINGS.sound
              : migrateSoundSettings(sound),
          agentArguments: recovered,
        };
        // ID-only consent is provable only for historically reserved built-ins.
        // Pin their historical identity, never the current provider's identity.
        const identities = { ...store.settings.agentBypassIdentities };
        for (const [agent, identity] of Object.entries(legacyBypassIdentities)) {
          if (
            store.settings.agentBypassAcknowledged[agent] &&
            !Object.hasOwn(identities, agent) &&
            Object.keys(identities).length < 100
          ) {
            identities[agent] = identity;
            migrated = true;
          }
        }
        if (migrated) store.settings = { ...store.settings, agentBypassIdentities: identities };
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
            const kept: Record<string, ThemeApproval> = {};
            for (const [file, value] of Object.entries(themes).slice(0, MAX_THEME_DIGESTS)) {
              if (!/^themes\/[^/]{1,200}$/.test(file)) continue;
              const approval = parseThemeApproval(value);
              if (approval) kept[file] = approval;
            }
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
        // Older builds reject sparse profile consent maps and may rewrite defaults.
        // Retain the original valid profile once, without retired inference secrets.
        const original = { ...state["settings"] };
        delete original["inference"];
        delete original["inferenceTimeoutMs"];
        backup = JSON.stringify({ ...state, settings: original });
        migrated ||= legacy || legacyAutoRemove;
      }
    } catch {
      // Defaults.
    }
    if (backup !== undefined) {
      const temporary = `${store.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, backup, { flag: "wx", mode: 0o600 });
        try {
          // A hard link publishes complete bytes exclusively; later loads never replace them.
          await link(temporary, join(userData, "settings-before-optional-agents.json"));
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
      } finally {
        await rm(temporary, { force: true });
      }
    }
    if (migrated || !hasRemoteProfile) await store.write(() => {});
    store.committedSettings = freezeSettings(store.settings);
    return store;
  }

  get(): Settings {
    return this.committedSettings;
  }

  /** Agent-editable values a version 1 profile still holds; undefined once migrated. */
  legacyConfig(): ConfigSettings | undefined {
    return this.migrated
      ? this.argumentsToMove
        ? freezeSettings({ agentArguments: this.argumentsToMove })
        : undefined
      : freezeSettings(this.legacy ?? {});
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
    const snapshot = structuredClone(values);
    await this.write(() => {
      this.writer = writer;
      this.migrated = true;
      this.legacy = undefined;
      this.argumentsToMove = undefined;
      this.digest = digest;
      this.settings = { ...this.settings, ...CONFIG_DEFAULTS, ...snapshot };
    });
  }

  /** Values from a validated config file; the file, not the profile, stores them. */
  setConfig(values: ConfigSettings): void {
    const before = this.committedSettings;
    const snapshot = freezeSettings(structuredClone(values));
    this.settings = { ...this.settings, ...CONFIG_DEFAULTS, ...snapshot };
    this.committedSettings = freezeSettings({ ...before, ...CONFIG_DEFAULTS, ...snapshot });
    settingsChanged(before, this.committedSettings);
  }

  /** Digest of the theme file this profile last applied: that theme's approval baseline. */
  themeDigest(file: string): ThemeApproval | null {
    return Object.hasOwn(this.themeDigests, file) ? (this.themeDigests[file] ?? null) : null;
  }

  async setThemeDigest(file: string, digest: ThemeApproval | null): Promise<void> {
    if (isDeepStrictEqual(this.themeDigest(file), digest)) return;
    const next: Record<string, ThemeApproval> = Object.fromEntries(
      Object.entries(this.themeDigests).filter(([key]) => key !== file),
    );
    if (digest !== null) next[file] = structuredClone(digest);
    if (Object.keys(next).length > MAX_THEME_DIGESTS) return;
    await this.write(() => {
      this.themeDigests = next;
    });
  }

  /** The config settings file this profile last applied. */
  configText(): string | null {
    return this.text;
  }

  async setConfigBaseline(
    digest: string,
    text: string,
    theme?: { file: string; digest: ThemeApproval },
  ): Promise<void> {
    if (Buffer.byteLength(text) > 65536) return;
    if (digest === this.digest && text === this.text && !theme) return;
    const approvedTheme = structuredClone(theme);
    await this.write(() => {
      this.digest = digest;
      this.text = text;
      if (approvedTheme) {
        const next = { ...this.themeDigests, [approvedTheme.file]: approvedTheme.digest };
        if (Object.keys(next).length <= MAX_THEME_DIGESTS) this.themeDigests = next;
      }
    });
  }

  /** Host observations and machine permission choices may be superseded before commit. */
  update(patch: SettingsPatch, themeDigest?: string): Promise<Settings>;
  update(patch: RegisteredHostsPatch, canCommit: (() => boolean) | undefined): Promise<Settings>;
  update(patch: AgentPermissionsPatch, canCommit: () => boolean): Promise<Settings>;
  async update(
    patch: SettingsPatch,
    themeDigestOrGuard?: string | (() => boolean),
  ): Promise<Settings> {
    const canCommit = typeof themeDigestOrGuard === "function" ? themeDigestOrGuard : undefined;
    const themeDigest = typeof themeDigestOrGuard === "string" ? themeDigestOrGuard : undefined;
    let snapshot = patch;
    if (canCommit) {
      const keys = Reflect.ownKeys(patch);
      const key = keys[0];
      const descriptor =
        key === undefined ? undefined : Object.getOwnPropertyDescriptor(patch, key);
      const value: unknown =
        descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
      if (keys.length === 1 && key === "registeredHosts" && Array.isArray(value))
        snapshot = { registeredHosts: value };
      else if (keys.length === 1 && key === "agentPermissions" && agentPermissions(value))
        snapshot = { agentPermissions: value };
      else
        throw new Error(
          "A commit guard requires a registeredHosts-only or agentPermissions-only patch",
        );
    }
    const config: ConfigSettings = {};
    const profile: SettingsPatch = {};
    for (const [key, value] of Object.entries(structuredClone(snapshot)))
      Object.assign(this.writer && isConfigSetting(key) ? config : profile, { [key]: value });
    if (this.writer && Object.keys(config).length)
      await this.writer(config, ...(themeDigest ? [themeDigest] : []));
    if (Object.keys(config).length && !Object.keys(profile).length) return this.committedSettings;
    await this.write(async () => {
      if (typeof profile.sourceDirectory === "string") {
        const requested = profile.sourceDirectory;
        const expanded = requested.startsWith("~/")
          ? join(homedir(), requested.slice(2))
          : requested;
        const canonical = await realpath(expanded).catch(() => undefined);
        if (!canonical || !(await stat(canonical).catch(() => undefined))?.isDirectory())
          throw new Error("Choose an existing source directory.");
        profile.sourceDirectory = canonical;
      }
      const argumentsPatch = profile.agentArguments;
      const agentArguments = argumentsPatch
        ? parseStoredAgentDefaults({ ...this.settings.agentArguments, ...argumentsPatch })
        : this.settings.agentArguments;
      const next = { ...this.settings, ...profile, agentArguments };
      if (profile.registeredHosts) {
        const current = new Map(this.settings.registeredHosts?.map((host) => [host.host, host]));
        for (const host of profile.registeredHosts) {
          const previous = current.get(host.host);
          if (previous?.codeFolder === host.codeFolder)
            hostRegistrationIdentities.set(host, hostRegistrationIdentity(previous));
        }
      }
      if (profile.agentPermissions || (profile.registeredHosts && this.settings.agentPermissions)) {
        const permissions = { ...this.settings.agentPermissions };
        for (const [scope, choices] of Object.entries(profile.agentPermissions ?? {})) {
          if (
            scope.startsWith("host:") &&
            !next.registeredHosts?.some(({ host }) => scope === `host:${host}`)
          )
            throw new Error("Machine is no longer registered.");
          permissions[scope] = Object.fromEntries(
            Object.entries({ ...permissions[scope], ...choices }).filter(
              ([, choice]) => choice !== null,
            ),
          );
        }
        const merged = Object.fromEntries(
          Object.entries(permissions).filter(
            ([scope, choices]) =>
              Object.keys(choices).length > 0 &&
              (!scope.startsWith("host:") ||
                next.registeredHosts?.some(({ host }) => scope === `host:${host}`)),
          ),
        );
        if (!agentPermissions(merged)) throw new Error("Too many agent permission choices.");
        next.agentPermissions = merged;
      }
      this.settings = next;
      if (argumentsPatch)
        this.argumentsToMove = Object.values(agentArguments).some((args) => args.length)
          ? agentArguments
          : undefined;
    }, canCommit);
    return this.committedSettings;
  }

  private async write(
    change: () => void | Promise<void>,
    canCommit?: () => boolean,
  ): Promise<void> {
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
        try {
          await change();
          await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
          const temporary = `${this.file}.${randomUUID()}.tmp`;
          try {
            await writeFile(
              temporary,
              JSON.stringify(
                this.migrated
                  ? {
                      version: 2,
                      remoteProfile: this.remoteProfile,
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
                  : { version: 1, remoteProfile: this.remoteProfile, settings: this.settings },
              ),
              { flag: "wx", mode: 0o600 },
            );
            if (canCommit) {
              if (!canCommit()) throw SUPERSEDED_PROFILE_WRITE;
              // Keep the revision check and replacement in the same JS turn.
              renameSync(temporary, this.file);
            } else {
              await rename(temporary, this.file);
            }
          } finally {
            await rm(temporary, { force: true });
          }
        } catch (error) {
          this.settings = {
            ...snapshot.settings,
            ...Object.fromEntries(CONFIG_SETTINGS.map((key) => [key, this.committedSettings[key]])),
          };
          this.migrated = snapshot.migrated;
          this.digest = snapshot.digest;
          this.text = snapshot.text;
          this.themeDigests = snapshot.themeDigests;
          this.writer = snapshot.writer;
          this.legacy = snapshot.legacy;
          this.argumentsToMove = snapshot.argumentsToMove;
          if (error !== SUPERSEDED_PROFILE_WRITE) throw error;
          return;
        }
        this.committedSettings = freezeSettings(this.settings);
        settingsChanged(snapshot.settings, this.settings);
      });
    this.pending = write;
    await write;
  }
}
