import { ConfigCatalog } from "./catalog";
import {
  ConfigFiles,
  decode,
  ignore,
  MAX_CONFIG_FILE_BYTES,
  SETTINGS_LOCK_FILE,
  settle,
} from "./files";
import { bundledForgeManifests } from "../control/forge-manifests";
import type { LoadedForgeManifest } from "./plugins";
import type { AgentProvider } from "../agents/providers/registry";
import { watch } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { rename } from "node:fs/promises";
import { lstat, mkdir } from "node:fs/promises";
import {
  hasBypassArgument,
  parseAgentDefaults,
  recoverAgentDefaults,
} from "../agents/default-arguments";
import { ApplicationError, errorMessage } from "../../shared/application-errors";
import type { DialogContent } from "../../shared/confirmation";
import type { ConfigSettings } from "../../shared/config";
import { parseSettingsFile } from "../../shared/config-files";
import type { ConfigStatus } from "../../shared/foom-config";
import { SOUND_KINDS } from "../../shared/sounds";
import type { ParsedThemeFile, ThemeKind, UserThemeId } from "../../shared/theme-file";
import { parseThemeFile } from "../../shared/theme-files";
import { attentionConflicts } from "../../shared/user-interface-theme";
import { isUserThemeId, ThemeValidationError, validThemeFile } from "../../shared/theme-validation";
import {
  argumentChanges,
  argumentDisclosure,
  effective,
  retainApproved,
  weakenings,
} from "./approval";
import type { EffectiveConfig, Weakening } from "./approval";
import { OWNED_FILES, SETTINGS_FILE, THEME_FOLDERS, digest, refreshable } from "./layout";

export interface ConfigServiceDependencies {
  root: string;
  defaults: EffectiveConfig;
  /** Pushes validated values into the running app. */
  apply(values: ConfigSettings): void;
  /** The profile persists the approved copy, its digest and any selected palette together. */
  baseline: {
    get(): string | null;
    copy?(): string | null;
    set(digest: string, text: string, theme?: { file: string; digest: string }): Promise<void>;
  };
  /** The profile's digest of each interface theme file it last applied, by config path. */
  themeBaseline: {
    get(file: string): string | null;
    set(file: string, value: string | null): Promise<void>;
  };
  applyPlugins?(providers: readonly AgentProvider[]): void;
  /** Catalog only: loading grants no enablement, executable or host authority. */
  applyForges?(plugins: readonly LoadedForgeManifest[]): void;
  confirmArguments?(content: DialogContent): Promise<boolean>;
  acknowledgeBypass?(agents: readonly string[]): Promise<void>;
  onStatus?(status: ConfigStatus): void;
  /** Attaches the Settings writer after a busy startup finishes in the background. */
  onDeferredReady?(values: ConfigSettings): Promise<void>;
  onThemeDecision?(): void;
  watch?: (directory: string, listener: (file: string | null) => void) => { close(): void };
  delay?: number;
  platform?: NodeJS.Platform;
  rename?: typeof rename;
}

interface Applied {
  text: string;
  values: ConfigSettings;
}

/** The unverified baseline: every default, as a valid file Keep it on can restore. */
const DEFAULTS: Applied = {
  text: `${JSON.stringify({ kind: "settings" }, null, 2)}\n`,
  values: {},
};

interface Palette {
  text: string;
  parsed: ParsedThemeFile;
}

interface Selection {
  file: string;
  source: string | null;
  palette: Palette | undefined;
  unavailable: boolean;
}

interface Pending extends Applied {
  id: string;
  weak: Weakening[];
  selection: Selection | undefined;
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

const SETTINGS_BUSY_MESSAGE = errorMessage(new ApplicationError("settings-busy"));

function settingsBusy(error: unknown): boolean {
  return error instanceof ApplicationError && error.code === "settings-busy";
}

function invalid(error: unknown): string {
  return error instanceof ThemeValidationError
    ? `${error.path}: ${error.reason}${error.detail ? `: ${error.detail}` : ""}`
    : "$: unreadable";
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
  private liveValues: ConfigSettings | undefined;
  private pending: Pending | null = null;
  private appliedThemes = new Map<string, Palette>();
  private heldThemes = new Map<
    string,
    { text: string; previous: string | null; settings: string | null; id: string }
  >();
  /** Each rejected file: the digest of the bytes rejected and a fixed reason. */
  private rejected = new Map<string, { object: string; reason: string }>();
  private queue: Promise<unknown> = Promise.resolve();
  private watchers = new Map<string, { close(): void }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryingScan = false;
  private deferredStartup = false;
  private profileWriteFailed = false;
  private available = true;
  private error: string | undefined;
  private closed = false;
  private started = false;

  private readonly files: ConfigFiles;
  private readonly plugins: ConfigCatalog;
  constructor(private readonly deps: ConfigServiceDependencies) {
    this.files = new ConfigFiles(deps);
    this.plugins = new ConfigCatalog(this.files, this.rejected, () => this.closed, deps);
  }

  get folder(): string {
    return this.deps.root;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(ignore).then(work);
    this.queue = next;
    return next;
  }

  /**
   * Creates the layout, refreshes unedited Foom-owned docs, and moves `legacy` profile values into
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
      await mkdir(this.files.path(folder), { recursive: true });
    for (const [relative, content] of Object.entries(OWNED_FILES)) {
      const current = await this.files.read(relative).catch(ignore);
      if (current !== undefined && refreshable(relative, current))
        await this.files.writeFile(relative, content);
    }
    let migrated: Applied | undefined;
    if ((await this.files.read(SETTINGS_FILE).catch(ignore)) === null) {
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
      if (await this.files.createFile(SETTINGS_FILE, text)) migrated = { text, values };
    }
    const baseline = await this.baseline(migrated);
    this.applied = baseline ?? DEFAULTS;
    if (!migrated && baseline && legacy?.agentArguments) {
      // Trust only the profile's arguments, not other edits made while Foom was closed.
      const baseline = { ...this.applied.values, agentArguments: legacy.agentArguments };
      const approvedText = `${JSON.stringify({ kind: "settings", ...baseline }, null, 2)}\n`;
      parseSettingsFile(approvedText);
      this.applied = { values: baseline, text: approvedText };
      // Preserve a recoverable approved baseline without rewriting working bytes.
      // They remain an external proposal, including a missing arguments key, and
      // must pass the scan below even if replaced during baseline persistence.
      await this.recordBaseline(this.applied.text);
    }
    if (migrated && this.applied === migrated) await this.recordBaseline(migrated.text);
    try {
      await this.scan(true);
      this.started = true;
    } catch (error) {
      if (!settingsBusy(error)) throw error;
      this.deferredStartup = true;
      this.retryScan(error);
      this.publish();
    }
    this.startWatching();
    if (this.deferredStartup)
      return { ...this.applied.values, interfaceTheme: "follow", terminalTheme: "follow" };
    return this.liveValues ?? this.applied.values;
  }

  /** The profile keeps the digest and a copy of the settings file it last applied. */
  private async recordBaseline(text: string): Promise<void> {
    await this.deps.baseline.set(digest(text), text);
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
    const working = await settle(this.files.read(SETTINGS_FILE), null);
    if (working) candidates.push(working);
    const copy = this.deps.baseline.copy?.();
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

  private startWatching(): void {
    this.watchFolder("", (file) => {
      const replaced = [...Object.values(THEME_FOLDERS), "agents", "forges"].find(
        (folder) => folder === file,
      );
      // A theme folder that was removed and recreated needs a new subscription.
      if (replaced) this.watchFolder(replaced);
      return (
        file === null ||
        file === SETTINGS_FILE ||
        (file === SETTINGS_LOCK_FILE && this.retryingScan) ||
        replaced !== undefined
      );
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
        (this.deps.watch ?? watchFolder)(this.files.path(folder), (file) => {
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
      void this.serial(async () => {
        // Ignore our own lock events while acquiring and scanning.
        this.retryingScan = false;
        try {
          await this.scan();
        } catch (error) {
          if (!settingsBusy(error) && !this.deferredStartup) throw error;
          this.retryScan(error);
        }
      }).catch(ignore);
    }, this.deps.delay ?? 250);
  }

  private retryScan(error?: unknown): void {
    if (this.deferredStartup) {
      const message =
        error === undefined || settingsBusy(error)
          ? undefined
          : errorMessage(error, "The Foom config folder is unavailable.");
      if (this.error !== message) {
        this.error = message;
        this.publish();
      }
    }
    this.retryingScan = true;
    this.schedule();
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

  private async scan(initial = false): Promise<void> {
    if (this.closed) return;
    await this.files.withSettingsLock(async () => {
      // Keep legacy profile values in use if startup has to defer the scan.
      if (initial) this.applyLive(this.applied.values);
      await this.scanSettings();
    });
    await this.scanPlugins();
    // Known names too, so a removed theme clears its applied, held or rejected state.
    const themes = new Set([
      ...(await this.plugins.themePaths()),
      ...this.appliedThemes.keys(),
      ...this.heldThemes.keys(),
      ...[...this.rejected.keys()].filter((path) => themeKind(path) !== undefined),
    ]);
    for (const relative of [...themes].sort()) await this.scanTheme(relative);
    await this.finishDeferredStartup();
    this.publish();
  }

  private async finishDeferredStartup(): Promise<void> {
    if (!this.deferredStartup || this.closed) return;
    try {
      await this.deps.onDeferredReady?.(this.liveValues ?? this.applied.values);
    } catch {
      this.profileWriteFailed = true;
      this.retryScan();
      return;
    }
    this.profileWriteFailed = false;
    this.deferredStartup = false;
    this.started = true;
    this.error = undefined;
  }

  private async scanPlugins(): Promise<void> {
    await this.plugins.scanPlugins();
    this.applyLive(this.applied.values);
  }

  private applyLive(values: ConfigSettings): void {
    const live = values.agentArguments
      ? { ...values, agentArguments: recoverAgentDefaults(values.agentArguments) }
      : values;
    if (isDeepStrictEqual(this.liveValues, live)) return;
    this.liveValues = live;
    this.deps.apply(live);
  }

  private async readSettings(): Promise<Applied | null> {
    let bytes: Buffer | null;
    try {
      bytes = await this.files.read(SETTINGS_FILE);
    } catch (error) {
      this.reject(SETTINGS_FILE, invalid(error), invalid(error));
      return null;
    }
    if (bytes === null) {
      this.reject(SETTINGS_FILE, "missing", "$: missing");
      return null;
    }
    let text: string;
    let values: ConfigSettings;
    try {
      text = decode(bytes);
      values = text === this.applied.text ? this.applied.values : parseSettingsFile(text);
    } catch (error) {
      this.reject(SETTINGS_FILE, digest(bytes), invalid(error));
      return null;
    }
    this.rejected.delete(SETTINGS_FILE);
    return { text, values };
  }

  private async inspectSettings(current: Applied): Promise<Pending> {
    const before = effective(this.deps.defaults, this.applied.values);
    const after = effective(this.deps.defaults, current.values);
    const selection = await this.readSelection(before.interfaceTheme, after.interfaceTheme);
    const weak = [
      ...weakenings(before, after),
      ...argumentChanges(before, after),
      ...this.themeSelectionWeakening(selection),
    ];
    const id = digest(
      selection
        ? JSON.stringify([
            current.text,
            selection.file,
            selection.source,
            selection.unavailable,
            selection.palette?.text,
          ])
        : current.text,
    );
    return { ...current, weak, id, selection };
  }

  private async scanSettings(): Promise<void> {
    const current = await this.readSettings();
    if (!current) return;
    if (current.text === this.applied.text) {
      this.pending = null;
      return;
    }
    const proposal = await this.inspectSettings(current);
    if (proposal.weak.length) this.pending = proposal;
    else await this.applyValues(proposal, proposal.selection);
  }

  /** The active palette comes from the same snapshot as the applied selection. */
  activePalette():
    | { id: UserThemeId; theme: Extract<ParsedThemeFile, { kind: "theme" }>["theme"] | undefined }
    | undefined {
    const id = effective(this.deps.defaults, this.applied.values).interfaceTheme;
    if (!isUserThemeId(id)) return undefined;
    const parsed = this.appliedThemes.get(`themes/${id.slice(5)}`)?.parsed;
    return { id, theme: parsed?.kind === "theme" ? parsed.theme : undefined };
  }

  private async applyValues(applied: Applied, selection?: Selection): Promise<void> {
    const palette = selection?.palette;
    if (selection) {
      if (palette) this.appliedThemes.set(selection.file, palette);
      else this.appliedThemes.delete(selection.file);
      this.heldThemes.delete(selection.file);
    }
    const previous = this.activePalette();
    const next = effective(this.deps.defaults, applied.values).interfaceTheme;
    if (previous && previous.id !== next) this.heldThemes.delete(`themes/${previous.id.slice(5)}`);
    this.applied = applied;
    this.pending = null;
    this.applyLive(applied.values);
    await this.deps.baseline
      .set(
        digest(applied.text),
        applied.text,
        selection && palette ? { file: selection.file, digest: digest(palette.text) } : undefined,
      )
      .catch(ignore);
  }

  /** Both watchers pass through this serialized gate before a palette reaches any window. */
  reviewTheme(
    file: string,
    text: string,
    parsed: ParsedThemeFile,
  ): Promise<ParsedThemeFile | undefined> {
    return this.serial(async () => {
      if (this.deferredStartup) return undefined;
      // The library reads before joining this queue. A config scan may already
      // have reviewed a newer edit, so an old snapshot must not clear its hold
      // or replace the profile's approval baseline.
      const bytes = await settle(this.files.read(file), null);
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
      const settings = await settle(this.files.read(SETTINGS_FILE), null);
      const settingsDigest = settings && digest(settings);
      this.heldThemes.set(file, {
        text,
        previous: previous?.text ?? null,
        settings: settingsDigest,
        id: digest(JSON.stringify([settingsDigest, file, text])),
      });
      if (previous) {
        this.appliedThemes.set(file, previous);
        return previous.parsed;
      }
      return undefined;
    }
    await this.acceptTheme(file, text, parsed, active === `user:${file.slice("themes/".length)}`);
    return parsed;
  }

  private async acceptTheme(
    file: string,
    text: string,
    parsed: ParsedThemeFile,
    active: boolean,
  ): Promise<void> {
    this.heldThemes.delete(file);
    this.appliedThemes.set(file, { text, parsed });
    if (!active) return;
    try {
      await this.deps.themeBaseline.set(file, digest(text));
    } catch {
      /* An unrecorded baseline only means a later restart holds this palette again. */
    }
  }

  private async readSelection(
    before: EffectiveConfig["interfaceTheme"],
    after: EffectiveConfig["interfaceTheme"],
  ): Promise<Selection | undefined> {
    if (before === after || !isUserThemeId(after)) return undefined;
    const file = `themes/${after.slice(5)}`;
    let source: string | null = null;
    try {
      const bytes = await this.files.read(file);
      if (bytes) {
        source = digest(bytes);
        const text = decode(bytes);
        return {
          file,
          source,
          palette: { text, parsed: parseThemeFile(text, "theme") },
          unavailable: false,
        };
      }
    } catch {
      return { file, source, palette: this.appliedThemes.get(file), unavailable: true };
    }
    return { file, source, palette: this.appliedThemes.get(file), unavailable: false };
  }

  private themeSelectionWeakening(selection?: Selection): Weakening[] {
    const parsed = selection?.palette?.parsed;
    if (
      parsed?.kind === "theme" &&
      parsed.warnings?.some((warning) => warning.reason === "attention-distinctness")
    )
      return [
        {
          field: ["interfaceTheme"],
          action: "use a theme where needs-you is hard to tell apart",
          detail: "interfaceTheme: attention-distinctness",
        },
      ];
    if (selection?.unavailable)
      return [
        {
          field: ["interfaceTheme"],
          action: "use a theme whose needs-you colors could not be checked",
          detail: "interfaceTheme: palette unavailable",
        },
      ];
    return [];
  }

  private async scanTheme(relative: string): Promise<void> {
    const kind = themeKind(relative);
    if (!kind) return;
    let bytes: Buffer | null;
    try {
      bytes = await this.files.read(relative);
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
    const error = [
      this.deferredStartup && SETTINGS_BUSY_MESSAGE,
      this.error,
      this.profileWriteFailed && "Unable to save profile settings.",
    ]
      .filter(Boolean)
      .join(" ");
    const pending = this.pending;
    const held = this.heldThemes.entries().next().value;
    const rejected = [...this.rejected]
      .map(([file, { reason }]) => ({ file, reason }))
      .sort((a, b) => a.file.localeCompare(b.file));
    return {
      forgePlugins: [
        ...bundledForgeManifests.map((manifest) => ({
          id: manifest.id,
          name: manifest.name,
          badge: manifest.badge,
          executables: manifest.executables,
        })),
        ...[...this.plugins.loadedPlugins].flatMap(([file, entry]) =>
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
            id: pending.id,
            action: pending.weak.map((entry) => entry.action).join(" and "),
            file: SETTINGS_FILE,
            detail: pending.weak.map((entry) => entry.detail).join(", "),
          }
        : held
          ? {
              id: held[1].id,
              file: held[0],
              action: "use a theme where needs-you is hard to tell apart",
              detail: "attention-distinctness",
            }
          : null,
      rejected,
      ...(error ? { error } : {}),
    };
  }

  private publish(): void {
    if (!this.closed) this.deps.onStatus?.(this.status());
  }

  /** Settings UI writes go through the same file. */
  write(patch: ConfigSettings): Promise<void> {
    return this.serial(() => this.writeSettings(patch));
  }

  private writeSettings(patch: ConfigSettings): Promise<void> {
    return this.files.withSettingsLock(() => this.writeSettingsLocked(patch));
  }

  private async writeSettingsLocked(patch: ConfigSettings, settings?: Applied): Promise<void> {
    // Read and merge while other profiles are excluded through the atomic rename.
    const current = settings ?? (await this.readSettings());
    const proposal = current ? await this.inspectSettings(current) : null;
    if (proposal?.weak.length) this.pending = proposal;
    if (!proposal || (proposal.weak.length && this.applied === DEFAULTS)) {
      this.publish();
      throw new Error(
        "Unable to read valid Foom settings. Retry after the file is available and reviewed.",
      );
    }
    let next: Applied;
    let approved: Applied;
    try {
      if (patch.agentArguments) parseAgentDefaults(patch.agentArguments);
      next = this.settingsFile(this.mergeSettings(proposal.values, patch));
      approved = proposal.weak.length ? this.approvedSettings(proposal, patch) : next;
    } catch {
      throw new Error("This setting cannot be stored in the Foom config folder");
    }
    await this.commitSettings(next, approved, patch.interfaceTheme !== undefined);
    this.publish();
  }

  private mergeSettings(values: ConfigSettings, patch: ConfigSettings): ConfigSettings {
    const merged = { ...values, ...patch };
    if (patch.agentArguments)
      merged.agentArguments = { ...values.agentArguments, ...patch.agentArguments };
    return merged;
  }

  private approvedSettings(proposal: Pending, patch: ConfigSettings = {}): Applied {
    const baseline = this.applied.values;
    const approved = retainApproved(this.deps.defaults, baseline, proposal.values, proposal.weak);
    try {
      return this.settingsFile(this.mergeSettings(approved, patch));
    } catch (error) {
      if (patch.agents !== undefined || !proposal.weak.some(({ field }) => field[0] === "agents"))
        throw error;
      // Restoring enabled entries can exceed the provider map limit.
      if (baseline.agents === undefined) delete approved.agents;
      else approved.agents = baseline.agents;
      return this.settingsFile(this.mergeSettings(approved, patch));
    }
  }

  private async commitSettings(
    next: Applied,
    approved: Applied,
    explicitTheme = false,
  ): Promise<void> {
    const before = effective(this.deps.defaults, this.applied.values);
    const after = effective(this.deps.defaults, approved.values);
    let reviewed: Selection | undefined;
    let fallback: Applied | undefined;
    if (before.interfaceTheme !== after.interfaceTheme && isUserThemeId(after.interfaceTheme)) {
      if (explicitTheme)
        reviewed = await this.readSelection(before.interfaceTheme, after.interfaceTheme);
      else {
        const values = { ...approved.values };
        if (this.applied.values.interfaceTheme === undefined) delete values.interfaceTheme;
        else values.interfaceTheme = this.applied.values.interfaceTheme;
        fallback = this.settingsFile(values);
      }
    }
    await this.files.writeFile(SETTINGS_FILE, next.text);
    // Palette writers do not take the settings lock. Inspect the working
    // palette after rename, then use the exact checked snapshot for display.
    if (fallback) {
      reviewed = await this.readSelection(before.interfaceTheme, after.interfaceTheme);
      if (this.themeSelectionWeakening(reviewed).length) {
        approved = fallback;
        reviewed = undefined;
      }
    }
    await this.applyValues(approved, reviewed);
    if (next.text !== this.applied.text) await this.scanSettings();
  }

  private settingsFile(values: ConfigSettings): Applied {
    if (isDeepStrictEqual(values, this.applied.values)) return this.applied;
    const file = { kind: "settings", ...values };
    const pretty = `${JSON.stringify(file, null, 2)}\n`;
    const text = Buffer.byteLength(pretty) <= MAX_CONFIG_FILE_BYTES ? pretty : JSON.stringify(file);
    return { text, values: parseSettingsFile(text) };
  }

  /** Decisions name the exact settings and palette snapshot shown for review. */
  decide(decision: unknown, id: unknown): Promise<ConfigStatus> {
    if (decision !== "allow" && decision !== "keep")
      return Promise.reject(new Error("Invalid decision"));
    return this.serial(async () => {
      const pending = this.pending;
      if (pending) {
        if (id !== pending.id) throw new Error("The change was replaced. Review it again.");
        await this.decideSettings(decision, pending);
      } else {
        await this.decideTheme(decision, id);
        this.deps.onThemeDecision?.();
      }
      this.publish();
      return this.status();
    });
  }

  private async decideSettings(decision: "allow" | "keep", pending: Pending): Promise<void> {
    const before = effective(this.deps.defaults, this.applied.values);
    const after = effective(this.deps.defaults, pending.values);
    const confirm = decision === "allow" && argumentChanges(before, after).length > 0;
    if (confirm) {
      if (!(await this.files.withSettingsLock(() => this.matchSettings(pending))))
        await this.changedProposal();
      if (!(await this.deps.confirmArguments?.(argumentDisclosure(before, after)))) return;
    }
    const committed = await this.files.withSettingsLock(async () => {
      let current = await this.matchSettings(pending);
      if (!current) return false;
      if (decision === "keep") {
        const approved = this.approvedSettings(current);
        await this.commitSettings(approved, approved);
        return true;
      }
      if (confirm) {
        const bypass = Object.keys(after.agentArguments).filter(
          (agent) =>
            !isDeepStrictEqual(before.agentArguments[agent], after.agentArguments[agent]) &&
            hasBypassArgument(agent, after.agentArguments[agent] ?? []),
        );
        if (bypass.length) {
          await this.deps.acknowledgeBypass?.(bypass);
          current = await this.matchSettings(pending);
          if (!current) return false;
        }
      }
      await this.applyValues(current, current.selection);
      return true;
    });
    if (!committed) await this.changedProposal();
  }

  private async matchSettings(pending: Pending): Promise<Pending | undefined> {
    const current = await this.readSettings();
    if (current?.text !== pending.text) return undefined;
    const proposal = await this.inspectSettings(current);
    if (proposal.id === pending.id) return proposal;
    return undefined;
  }

  private async decideTheme(decision: "allow" | "keep", id: unknown): Promise<void> {
    const held = this.heldThemes.entries().next().value;
    if (!held) throw new Error("No change is waiting for approval");
    const [file, proposal] = held;
    if (id !== proposal.id) throw new Error("The change was replaced. Review it again.");
    const committed = await this.files.withSettingsLock(async () => {
      const current = await this.readSettings();
      const bytes = await settle(this.files.read(file), null);
      if (
        !current ||
        digest(current.text) !== proposal.settings ||
        effective(this.deps.defaults, current.values).interfaceTheme !== `user:${file.slice(7)}` ||
        !bytes?.equals(Buffer.from(proposal.text))
      )
        return false;
      if (decision === "allow")
        await this.acceptTheme(file, proposal.text, parseThemeFile(proposal.text, "theme"), true);
      else if (proposal.previous === null)
        await this.writeSettingsLocked(
          { interfaceTheme: this.deps.defaults.interfaceTheme },
          current,
        );
      else await this.files.writeFile(file, proposal.previous);
      this.heldThemes.delete(file);
      return true;
    });
    if (!committed) await this.changedProposal();
    await this.scan();
  }

  private async changedProposal(): Promise<never> {
    await this.scan();
    throw new Error("The file changed. Review the new change.");
  }

  async dispose(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    await this.queue.catch(ignore);
  }
}
