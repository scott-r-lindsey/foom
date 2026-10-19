import { githubManifest } from "../control/forge-manifests";
import type { LoadedForgeManifest } from "./plugins";
import { parsePluginManifest } from "../../shared/plugin-parser";
import { AgentManifestError } from "../../shared/agent-manifest";
import { v2Provider } from "../agents/providers/v2";
import type { AgentProvider } from "../agents/providers/registry";
import { randomUUID } from "node:crypto";
import { constants, watch } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  hasBypassArgument,
  parseAgentDefaults,
  recoverAgentDefaults,
} from "../agents/default-arguments";
import type { DialogContent } from "../../shared/confirmation";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConfigSettings } from "../../shared/config";
import { parseSettingsFile } from "../../shared/config-files";
import type { ConfigStatus } from "../../shared/foom-config";
import { SOUND_KINDS } from "../../shared/sounds";
import type { ParsedThemeFile, ThemeKind } from "../../shared/theme-file";
import { parseThemeFile } from "../../shared/theme-files";
import { attentionConflicts } from "../../shared/user-interface-theme";
import { ThemeValidationError, validThemeFile } from "../../shared/theme-validation";
import { argumentChanges, argumentDisclosure, effective, weakenings } from "./approval";
import type { EffectiveConfig, Weakening } from "./approval";
import { OWNED_FILES, SETTINGS_FILE, THEME_FOLDERS, digest, refreshable } from "./layout";

const MAX_FILE = 65536;
const MAX_THEMES = 50;

export interface ConfigServiceDependencies {
  root: string;
  defaults: EffectiveConfig;
  /** Pushes validated values into the running app. */
  apply(values: ConfigSettings): void;
  /** The profile's digest of the settings file it last applied: the approval baseline. */
  baseline: { get(): string | null; set(value: string): Promise<void> };
  /** The profile's copy of that file, so Keep it on can restore it after a restart. */
  appliedText?: { get(): string | null; set(text: string): Promise<void> };
  /** The profile's digest of each interface theme file it last applied, by config path. */
  themeBaseline: {
    get(file: string): string | null;
    set(file: string, value: string | null): Promise<void>;
  };
  applyPlugins?(providers: readonly AgentProvider[]): void;
  /** Catalog only: loading grants no enablement, executable or host authority. */
  applyForges?(plugins: readonly LoadedForgeManifest[]): void;
  confirmArguments?(content: DialogContent): Promise<boolean>;
  acknowledgeBypass?(agents: readonly ("claude" | "codex" | "agy")[]): Promise<void>;
  onStatus?(status: ConfigStatus): void;
  onThemeDecision?(): void;
  watch?: (directory: string, listener: (file: string | null) => void) => { close(): void };
  delay?: number;
  platform?: NodeJS.Platform;
  rename?: typeof rename;
}

type LoadedPlugin = { text: string } & (
  | { kind: "agent"; provider: AgentProvider }
  | { kind: "forge"; forge: LoadedForgeManifest }
);

interface Applied {
  text: string;
  values: ConfigSettings;
}

/** The unverified baseline: every default, as a valid file Keep it on can restore. */
const DEFAULTS: Applied = {
  text: `${JSON.stringify({ kind: "settings" }, null, 2)}\n`,
  values: {},
};

interface Pending extends Applied {
  weak: Weakening[];
}

/** Rejections that only mean "unavailable"; the caller falls back. */
const ignore = (): undefined => undefined;
async function settle<T, F>(promise: Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

const watchFolder = (directory: string, listener: (file: string | null) => void) => {
  const watcher = watch(directory, (_event, file) => {
    listener(typeof file === "string" ? file : null);
  });
  watcher.on("error", () => {
    watcher.close();
  });
  return watcher;
};

function invalid(error: unknown): string {
  return error instanceof ThemeValidationError
    ? `${error.path}: ${error.reason}${error.detail ? `: ${error.detail}` : ""}`
    : "$: unreadable";
}

/** Reads a direct regular file without following links; null when it does not exist. */
async function readConfigFile(path: string): Promise<Buffer | null> {
  const before = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new ThemeValidationError("$", "unreadable");
  });
  if (!before) return null;
  if (!before.isFile()) throw new ThemeValidationError("$", "unsafe-file");
  if (before.size > MAX_FILE) throw new ThemeValidationError("$", "too-large");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new ThemeValidationError("$", "unsafe-file");
  });
  try {
    const info = await file.stat();
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev)
      throw new ThemeValidationError("$", "unsafe-file");
    const bytes = Buffer.alloc(MAX_FILE + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await file.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_FILE) throw new ThemeValidationError("$", "too-large");
    return bytes.subarray(0, count);
  } finally {
    await file.close();
  }
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ThemeValidationError("$", "malformed-json");
  }
}

function themeKind(path: string): ThemeKind | undefined {
  const [folder, name, ...rest] = path.split("/");
  if (rest.length || !name || !validThemeFile(name)) return undefined;
  return folder === THEME_FOLDERS.theme
    ? "theme"
    : folder === THEME_FOLDERS["terminal-theme"]
      ? "terminal-theme"
      : undefined;
}

/**
 * The Foom config folder: plain files that Foom validates, applies live when safe,
 * and holds for approval when a change would weaken attention.
 */
export class ConfigService {
  private applied: Applied = DEFAULTS;
  private pending: Pending | null = null;
  private loadedPlugins = new Map<string, LoadedPlugin>();
  private appliedThemes = new Map<string, { text: string; parsed: ParsedThemeFile }>();
  private heldThemes = new Map<string, { text: string; previous: string | null }>();
  /** Each rejected file: the digest of the bytes rejected and a fixed reason. */
  private rejected = new Map<string, { object: string; reason: string }>();
  private queue: Promise<unknown> = Promise.resolve();
  private watchers = new Map<string, { close(): void }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private available = true;
  private error: string | undefined;
  private closed = false;
  private started = false;

  constructor(private readonly deps: ConfigServiceDependencies) {}

  get folder(): string {
    return this.deps.root;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(ignore).then(work);
    this.queue = next;
    return next;
  }

  private path(relative: string): string {
    return join(this.deps.root, ...relative.split("/"));
  }

  /**
   * Whether a folder inside the config root is a real directory at its expected place.
   * `O_NOFOLLOW` guards only the last path component, so a `themes` link to another
   * directory must be refused before reading, writing or removing anything in it.
   */
  private async contained(folder: string): Promise<boolean> {
    if (!folder) return true;
    try {
      const info = await lstat(this.path(folder));
      if (!info.isDirectory()) return false;
      const root = await realpath(this.deps.root);
      return (await realpath(this.path(folder))) === join(root, ...folder.split("/"));
    } catch {
      return false;
    }
  }

  private async read(relative: string): Promise<Buffer | null> {
    if (!(await this.contained(dirname(relative).replace(/^\.$/, ""))))
      throw new ThemeValidationError("$", "unsafe-file");
    return readConfigFile(this.path(relative));
  }

  /** Atomic replacement inside the folder; the temporary name is hidden from the catalogs. */
  private async writeFile(relative: string, content: Uint8Array | string): Promise<void> {
    const target = this.path(relative);
    await mkdir(dirname(target), { recursive: true });
    if (!(await this.contained(dirname(relative).replace(/^\.$/, ""))))
      throw new Error("A Foom config folder is redirected outside the config folder");
    const temporary = join(dirname(target), `.foom-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o644 });
      // Windows scanners can briefly deny replacement even after our readers close.
      // Five attempts, at most 375 ms of backoff; never unlink the existing target.
      for (let attempt = 0; ; attempt++) {
        try {
          await (this.deps.rename ?? rename)(temporary, target);
          break;
        } catch (error) {
          if (
            (this.deps.platform ?? process.platform) !== "win32" ||
            !(error instanceof Error) ||
            !("code" in error) ||
            (error.code !== "EPERM" && error.code !== "EBUSY") ||
            attempt === 4
          )
            throw new Error(`Unable to replace ${relative}. The change was not applied.`, {
              cause: error,
            });
          await sleep(25 * 2 ** attempt);
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /**
   * Creates the layout, refreshes unedited Foom-owned docs, turns the folder into a
   * repository when it is not one, and moves `legacy` profile values into
   * `settings.json` if that file does not exist yet. Returns the applied values.
   */
  initialize(legacy?: ConfigSettings): Promise<ConfigSettings> {
    return this.serial(async () => {
      try {
        return await this.setUp(legacy);
      } catch (error) {
        this.available = false;
        this.error = "The Foom config folder is unavailable.";
        this.publish();
        throw error;
      }
    });
  }

  /** True once the folder and its settings are in use. */
  get ready(): boolean {
    return this.started;
  }

  private async setUp(legacy?: ConfigSettings): Promise<ConfigSettings> {
    const info = await settle(lstat(this.deps.root), null);
    if (info && !info.isDirectory()) throw new Error("Foom config is not a folder");
    for (const folder of [
      "",
      THEME_FOLDERS.theme,
      THEME_FOLDERS["terminal-theme"],
      "schemas",
      "examples",
      "agents",
      "forges",
      ...SOUND_KINDS.map((kind) => `sounds/${kind}`),
    ])
      await mkdir(this.path(folder), { recursive: true });
    for (const [relative, content] of Object.entries(OWNED_FILES)) {
      const current = await this.read(relative).catch(ignore);
      if (current !== undefined && refreshable(relative, current))
        await this.writeFile(relative, content);
    }
    let migrated: Applied | undefined;
    if ((await this.read(SETTINGS_FILE).catch(ignore)) === null) {
      // Portable palette objects predate theme files and cannot be expressed in this file.
      const values: ConfigSettings = {};
      for (const [key, value] of Object.entries(legacy ?? {})) {
        try {
          Object.assign(
            values,
            parseSettingsFile(JSON.stringify({ kind: "settings", [key]: value })),
          );
        } catch (error) {
          if (key === "agentArguments") throw error;
          // Dropped; the default applies.
        }
      }
      const text = `${JSON.stringify({ kind: "settings", ...values }, null, 2)}\n`;
      parseSettingsFile(text);
      await this.writeFile(SETTINGS_FILE, text);
      migrated = { text, values };
    }
    this.applied = (await this.baseline(migrated)) ?? DEFAULTS;
    if (!migrated && legacy?.agentArguments) {
      // Trust only the profile's arguments, not other edits made while Foom was closed.
      const bytes = await this.read(SETTINGS_FILE);
      if (!bytes) throw new Error("Cannot migrate agent arguments without settings");
      const text = decode(bytes);
      const values = parseSettingsFile(text);
      const baseline = { ...this.applied.values, agentArguments: legacy.agentArguments };
      const approvedText = `${JSON.stringify({ kind: "settings", ...baseline }, null, 2)}\n`;
      parseSettingsFile(approvedText);
      this.applied = { values: baseline, text: approvedText };
      if (values.agentArguments === undefined) {
        const migratedText = `${JSON.stringify({ kind: "settings", ...values, agentArguments: legacy.agentArguments }, null, 2)}\n`;
        parseSettingsFile(migratedText);
        await this.writeFile(SETTINGS_FILE, migratedText);
      }
      // Keep a recoverable approved baseline even when the working file has a held edit.
      await this.recordBaseline(this.applied.text);
    }
    if (migrated && this.applied === migrated) await this.recordBaseline(migrated.text);
    this.deps.apply(this.applied.values);
    await this.scan();
    this.startWatching();
    this.started = true;
    return this.applied.values;
  }

  /** The profile keeps the digest and a copy of the settings file it last applied. */
  private async recordBaseline(text: string): Promise<void> {
    await this.deps.baseline.set(digest(text));
    await this.deps.appliedText?.set(text);
  }

  /**
   * What this profile last applied. The working file counts only if its digest matches;
   * otherwise the profile's copy, if it matches. Anything else is unverified and is
   * compared against the defaults, so an off switch made while Foom was closed is held.
   */
  private async baseline(migrated?: Applied): Promise<Applied | undefined> {
    if (migrated) return migrated;
    const known = this.deps.baseline.get();
    if (!known) return undefined;
    const candidates: Uint8Array[] = [];
    const working = await settle(this.read(SETTINGS_FILE), null);
    if (working) candidates.push(working);
    const copy = this.deps.appliedText?.get();
    if (copy) candidates.push(Buffer.from(copy));
    for (const bytes of candidates) {
      if (digest(bytes) !== known) continue;
      try {
        const text = decode(bytes);
        return { text, values: parseSettingsFile(text) };
      } catch {
        // A matching digest of an invalid file cannot be a baseline.
      }
    }
    return undefined;
  }

  /** At most 50 eligible names per theme folder, sorted. */
  private async themePaths(): Promise<string[]> {
    const paths: string[] = [];
    for (const folder of Object.values(THEME_FOLDERS)) {
      if (!(await this.contained(folder))) continue;
      const names = await settle(readdir(this.path(folder)), [] as string[]);
      paths.push(
        ...names
          .filter((name) => validThemeFile(name))
          .sort()
          .slice(0, MAX_THEMES)
          .map((name) => `${folder}/${name}`),
      );
    }
    return paths;
  }

  private startWatching(): void {
    this.watchFolder("", (file) => {
      const replaced = [...Object.values(THEME_FOLDERS), "agents", "forges"].find(
        (folder) => folder === file,
      );
      // A theme folder that was removed and recreated needs a new subscription.
      if (replaced) this.watchFolder(replaced);
      return file === null || file === SETTINGS_FILE || replaced !== undefined;
    });
    for (const folder of [...Object.values(THEME_FOLDERS), "agents", "forges"])
      this.watchFolder(folder);
  }

  private watchFolder(folder: string, relevant: (file: string | null) => boolean = () => true) {
    this.watchers.get(folder)?.close();
    this.watchers.delete(folder);
    if (this.closed) return;
    try {
      this.watchers.set(
        folder,
        (this.deps.watch ?? watchFolder)(this.path(folder), (file) => {
          if (relevant(file)) this.schedule();
        }),
      );
    } catch {
      // A missing folder is reported by the next scan; the root watcher retries it.
    }
  }

  /** About 250 ms after the last change, validate and apply what changed. */
  private schedule(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.serial(() => this.scan()).catch(ignore);
    }, this.deps.delay ?? 250);
  }

  /** Runs one scan now; tests and IPC use it instead of waiting for the watcher. */
  refresh(): Promise<ConfigStatus> {
    return this.serial(async () => {
      await this.scan();
      return this.status();
    });
  }

  private reject(file: string, object: string, reason: string): void {
    this.rejected.set(file, { object, reason });
  }

  private async scan(): Promise<void> {
    if (this.closed) return;
    await this.scanSettings();
    await this.scanPlugins();
    // Known names too, so a removed theme clears its applied, held or rejected state.
    const themes = new Set([
      ...(await this.themePaths()),
      ...this.appliedThemes.keys(),
      ...this.heldThemes.keys(),
      ...[...this.rejected.keys()].filter((path) => themeKind(path) !== undefined),
    ]);
    for (const relative of [...themes].sort()) await this.scanTheme(relative);
    this.publish();
  }

  private async pluginPaths(): Promise<string[]> {
    const paths: string[] = [];
    for (const folder of ["agents", "forges"]) {
      if (!(await this.contained(folder))) continue;
      const names = await readdir(this.path(folder)).catch(() => []);
      paths.push(
        ...names
          .filter((name) => /^[a-z][a-z0-9-]{0,39}\.json$/u.test(name))
          .sort()
          .slice(0, 50)
          .map((name) => `${folder}/${name}`),
      );
    }
    return paths;
  }

  /** A valid manifest loads as read; an edit reloads it and an invalid file is rejected whole. */
  private async scanPlugins(): Promise<void> {
    const eligible = new Set(await this.pluginPaths());
    const paths = new Set([
      ...eligible,
      ...this.loadedPlugins.keys(),
      ...[...this.rejected.keys()].filter(
        (file) => file.startsWith("agents/") || file.startsWith("forges/"),
      ),
    ]);
    const active: AgentProvider[] = [];
    const forges: LoadedForgeManifest[] = [];
    for (const file of paths) {
      if (!eligible.has(file)) {
        this.loadedPlugins.delete(file);
        this.rejected.delete(file);
        continue;
      }
      let bytes: Buffer | null;
      try {
        bytes = await this.read(file);
      } catch {
        this.loadedPlugins.delete(file);
        this.reject(file, "unreadable", "$: unsafe-file");
        continue;
      }
      if (!bytes) {
        this.loadedPlugins.delete(file);
        this.rejected.delete(file);
        continue;
      }
      let text: string;
      let loaded: ReturnType<typeof parsePluginManifest>;
      try {
        text = decode(bytes);
        loaded = parsePluginManifest(text);
        const folder = loaded.kind === "agent" ? "agents" : "forges";
        if (!file.startsWith(`${folder}/`)) throw new AgentManifestError("$", "invalid-kind");
        const identifier = loaded.kind === "agent" ? loaded.plugin.model.id : loaded.plugin.id;
        if (file !== `${folder}/${identifier}.json`)
          throw new AgentManifestError("$.id", "filename-mismatch");
      } catch (error) {
        this.loadedPlugins.delete(file);
        this.reject(
          file,
          digest(bytes),
          error instanceof AgentManifestError ? error.message : "$: invalid-manifest",
        );
        continue;
      }
      this.rejected.delete(file);
      const hash = digest(bytes);
      const previous = this.loadedPlugins.get(file);
      // A launch/sample binds the bytes it was offered; edits wait for the next scan.
      const validate = async () => {
        const current = await this.read(file);
        if (
          this.closed ||
          this.loadedPlugins.get(file) !== entry ||
          !current ||
          digest(current) !== hash
        )
          throw new Error("Agent or forge plugin changed. Try again.");
      };
      let entry: LoadedPlugin;
      if (previous?.text === text) entry = previous;
      else if (loaded.kind === "agent")
        entry = {
          kind: "agent",
          text,
          provider: v2Provider(loaded.plugin.model, validate),
        };
      else
        entry = { kind: "forge", text, forge: { manifest: loaded.plugin, digest: hash, validate } };
      this.loadedPlugins.set(file, entry);
      if (entry.kind === "agent") active.push(entry.provider);
      else forges.push(entry.forge);
    }
    this.deps.applyForges?.(forges);
    this.deps.applyPlugins?.(active);
    const defaults = this.applied.values.agentArguments;
    if (defaults) {
      const recovered = recoverAgentDefaults(defaults);
      if (JSON.stringify(recovered) !== JSON.stringify(defaults)) {
        this.applied.values = { ...this.applied.values, agentArguments: recovered };
        this.deps.apply(this.applied.values);
      }
    }
  }

  private async scanSettings(): Promise<void> {
    let bytes: Buffer | null;
    try {
      bytes = await this.read(SETTINGS_FILE);
    } catch (error) {
      this.reject(SETTINGS_FILE, invalid(error), invalid(error));
      return;
    }
    if (bytes === null) {
      this.reject(SETTINGS_FILE, "missing", "$: missing");
      return;
    }
    let text: string;
    let values: ConfigSettings;
    try {
      text = decode(bytes);
      if (text === this.applied.text) {
        this.rejected.delete(SETTINGS_FILE);
        this.pending = null;
        return;
      }
      values = parseSettingsFile(text);
    } catch (error) {
      this.reject(SETTINGS_FILE, digest(bytes), invalid(error));
      return;
    }
    this.rejected.delete(SETTINGS_FILE);
    const before = effective(this.deps.defaults, this.applied.values);
    const after = effective(this.deps.defaults, values);
    const weak = [
      ...weakenings(before, after),
      ...argumentChanges(before, after),
      ...(await this.themeSelectionWeakening(before, after)),
    ];
    if (weak.length) {
      if (this.pending?.text !== text) this.pending = { text, values, weak };
      return;
    }
    await this.applyValues(text, values);
  }

  /** Applies validated settings and records them as the profile's baseline. */
  private async applyValues(text: string, values: ConfigSettings): Promise<void> {
    this.deps.apply(values);
    this.applied = { text, values };
    this.pending = null;
    await this.recordBaseline(text).catch(ignore);
  }

  /** Both watchers pass through this serialized gate before a palette reaches any window. */
  reviewTheme(
    file: string,
    text: string,
    parsed: ParsedThemeFile,
  ): Promise<ParsedThemeFile | undefined> {
    return this.serial(async () => {
      // The library reads before joining this queue. A config scan may already
      // have reviewed a newer edit, so an old snapshot must not clear its hold
      // or replace the profile's approval baseline.
      const bytes = await settle(this.read(file), null);
      if (!bytes || decode(bytes) !== text) return this.appliedThemes.get(file)?.parsed;
      const accepted = await this.reviewThemeValue(file, text, parsed);
      this.publish();
      return accepted;
    });
  }

  private async reviewThemeValue(
    file: string,
    text: string,
    parsed: ParsedThemeFile,
  ): Promise<ParsedThemeFile | undefined> {
    const kind = themeKind(file);
    if (kind !== "theme" || parsed.kind !== "theme") {
      this.appliedThemes.set(file, { text, parsed });
      return parsed;
    }
    // The approval baseline is only the version this profile last applied: in memory,
    // or after a restart the unchanged file matching the digest the profile keeps.
    const previous =
      this.appliedThemes.get(file) ??
      (digest(text) === this.deps.themeBaseline.get(file) ? { text, parsed } : undefined);
    const conflicts = (value: ParsedThemeFile | undefined) =>
      value?.kind === "theme" ? attentionConflicts(value.theme) : [];
    const approved = new Set(conflicts(previous?.parsed));
    const active = effective(this.deps.defaults, this.applied.values).interfaceTheme;
    if (
      active === `user:${file.slice("themes/".length)}` &&
      conflicts(parsed).some((conflict) => !approved.has(conflict))
    ) {
      // Keep it on restores the approved version; without one it leaves the theme instead.
      this.heldThemes.set(file, { text, previous: previous?.text ?? null });
      if (previous) {
        this.appliedThemes.set(file, previous);
        return previous.parsed;
      }
      return undefined;
    }
    await this.acceptTheme(file, text, parsed);
    return parsed;
  }

  private async acceptTheme(file: string, text: string, parsed: ParsedThemeFile): Promise<void> {
    this.heldThemes.delete(file);
    this.appliedThemes.set(file, { text, parsed });
    try {
      await this.deps.themeBaseline.set(file, digest(text));
    } catch {
      /* An unrecorded baseline only means a later restart holds this palette again. */
    }
  }

  private async themeSelectionWeakening(
    before: EffectiveConfig,
    after: EffectiveConfig,
  ): Promise<Weakening[]> {
    if (
      before.interfaceTheme === after.interfaceTheme ||
      typeof after.interfaceTheme !== "string" ||
      !after.interfaceTheme.startsWith("user:")
    )
      return [];
    const file = `themes/${after.interfaceTheme.slice(5)}`;
    let parsed = this.appliedThemes.get(file)?.parsed;
    try {
      const bytes = await this.read(file);
      if (!bytes) return [];
      parsed = parseThemeFile(decode(bytes), "theme");
    } catch {
      /* Invalid or unreadable edits retain the catalog's last accepted palette. */
    }
    if (
      parsed?.kind === "theme" &&
      parsed.warnings?.some((warning) => warning.reason === "attention-distinctness")
    )
      return [
        {
          action: "use a theme where needs-you is hard to tell apart",
          detail: "interfaceTheme: attention-distinctness",
        },
      ];
    return [];
  }

  private async scanTheme(relative: string): Promise<void> {
    const kind = themeKind(relative);
    if (!kind) return;
    let bytes: Buffer | null;
    try {
      bytes = await this.read(relative);
    } catch (error) {
      this.heldThemes.delete(relative);
      this.reject(relative, invalid(error), invalid(error));
      return;
    }
    if (bytes === null) {
      this.appliedThemes.delete(relative);
      this.heldThemes.delete(relative);
      if (kind === "theme") await settle(this.deps.themeBaseline.set(relative, null), undefined);
      this.rejected.delete(relative);
      return;
    }
    try {
      const text = decode(bytes);
      await this.reviewThemeValue(relative, text, parseThemeFile(text, kind));
    } catch (error) {
      this.heldThemes.delete(relative);
      this.reject(relative, digest(bytes), invalid(error));
      return;
    }
    this.rejected.delete(relative);
  }

  status(): ConfigStatus {
    const pending = this.pending;
    const held = this.heldThemes.entries().next().value;
    const rejected = [...this.rejected]
      .map(([file, { reason }]) => ({ file, reason }))
      .sort((a, b) => a.file.localeCompare(b.file));
    return {
      forgePlugins: [
        {
          id: githubManifest.id,
          name: githubManifest.name,
          badge: githubManifest.badge,
          executables: githubManifest.executables,
        },
        ...[...this.loadedPlugins].flatMap(([file, entry]) =>
          entry.kind === "forge"
            ? [
                {
                  id: entry.forge.manifest.id,
                  name: entry.forge.manifest.name,
                  badge: entry.forge.manifest.badge,
                  executables: entry.forge.manifest.executables,
                  file,
                },
              ]
            : [],
        ),
        ...rejected
          .filter(({ file }) => file.startsWith("forges/"))
          .map(({ file, reason }) => ({
            id: file.slice(7, -5),
            name: file.slice(7, -5),
            badge: "?",
            executables: [],
            file,
            reason,
          })),
      ],
      agentPlugins: rejected
        .filter(({ file }) => file.startsWith("agents/"))
        .map(({ file, reason }) => ({
          id: file.slice(7, -5),
          name: file.slice(7, -5),
          mark: "?",
          command: file.slice(7, -5),
          file,
          state: "rejected" as const,
          reason,
        })),
      folder: this.deps.root,
      available: this.available,
      pending: pending
        ? {
            id: digest(pending.text),
            action: pending.weak.map((entry) => entry.action).join(" and "),
            file: SETTINGS_FILE,
            detail: pending.weak.map((entry) => entry.detail).join(", "),
          }
        : held
          ? {
              id: digest(held[0] + held[1].text),
              file: held[0],
              action: "use a theme where needs-you is hard to tell apart",
              detail: "attention-distinctness",
            }
          : null,
      rejected,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private publish(): void {
    if (!this.closed) this.deps.onStatus?.(this.status());
  }

  /** Settings UI writes go through the same file. */
  write(patch: ConfigSettings): Promise<void> {
    return this.serial(() => this.writeSettings(patch));
  }

  private async writeSettings(patch: ConfigSettings): Promise<void> {
    const text = `${JSON.stringify({ kind: "settings", ...this.applied.values, ...patch }, null, 2)}\n`;
    let values: ConfigSettings;
    try {
      values = parseSettingsFile(text);
      if (values.agentArguments) parseAgentDefaults(values.agentArguments);
    } catch {
      throw new Error("This setting cannot be stored in the Foom config folder");
    }
    await this.writeFile(SETTINGS_FILE, text);
    await this.applyValues(text, values);
    this.publish();
  }

  /**
   * Allow applies the held change; keep restores the applied file. `id`
   * names the proposal the user saw, so a click never approves a later replacement.
   */
  decide(decision: unknown, id: unknown): Promise<ConfigStatus> {
    if (decision !== "allow" && decision !== "keep")
      return Promise.reject(new Error("Invalid decision"));
    return this.serial(async () => {
      const pending = this.pending;
      if (!pending) {
        const held = this.heldThemes.entries().next().value;
        if (!held) throw new Error("No change is waiting for approval");
        const [file, proposal] = held;
        if (id !== digest(file + proposal.text))
          throw new Error("The change was replaced. Review it again.");
        const bytes = await settle(this.read(file), null);
        if (!bytes || decode(bytes) !== proposal.text) {
          await this.scan();
          throw new Error("The file changed. Review the new change.");
        }
        if (decision === "allow")
          await this.acceptTheme(file, proposal.text, parseThemeFile(proposal.text, "theme"));
        else if (proposal.previous === null)
          await this.writeSettings({ interfaceTheme: this.deps.defaults.interfaceTheme });
        else await this.writeFile(file, proposal.previous);
        this.heldThemes.delete(file);
        await this.scan();
        this.deps.onThemeDecision?.();
        return this.status();
      }
      if (id !== digest(pending.text)) throw new Error("The change was replaced. Review it again.");
      const bytes = await settle(this.read(SETTINGS_FILE), null);
      if (!bytes || bytes.toString("utf8") !== pending.text) {
        await this.scan();
        throw new Error("The file changed. Review the new change.");
      }
      if (decision === "allow") {
        const before = effective(this.deps.defaults, this.applied.values);
        const after = effective(this.deps.defaults, pending.values);
        if (argumentChanges(before, after).length) {
          if (!(await this.deps.confirmArguments?.(argumentDisclosure(before, after))))
            return this.status();
          // The dialog can remain open while an agent replaces the proposal.
          const current = await settle(this.read(SETTINGS_FILE), null);
          if (!current || decode(current) !== pending.text) {
            await this.scan();
            throw new Error("The file changed. Review the new change.");
          }
          const bypass = (["claude", "codex", "agy"] as const).filter(
            (agent) =>
              JSON.stringify(before.agentArguments[agent]) !==
                JSON.stringify(after.agentArguments[agent]) &&
              hasBypassArgument(agent, after.agentArguments[agent]),
          );
          if (bypass.length) await this.deps.acknowledgeBypass?.(bypass);
        }
        await this.applyValues(pending.text, pending.values);
      } else {
        await this.writeFile(SETTINGS_FILE, this.applied.text);
        this.pending = null;
      }
      this.publish();
      return this.status();
    });
  }

  async dispose(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    await this.queue.catch(ignore);
  }
}
