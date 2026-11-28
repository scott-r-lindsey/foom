import { ApplicationError } from "../../shared/application-errors";
import { ConfigCatalog } from "./catalog";
import { ConfigFiles, decode, ignore, MAX_CONFIG_FILE_BYTES, settle } from "./files";
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
import type { DialogContent } from "../../shared/confirmation";
import type { ConfigSettings } from "../../shared/config";
import { parseSettingsFile } from "../../shared/config-files";
import type { ConfigStatus } from "../../shared/foom-config";
import { SOUND_KINDS } from "../../shared/sounds";
import type {
  ParsedThemeFile,
  ThemeKind,
  ThemeSnapshot,
  UserThemeId,
} from "../../shared/theme-file";
import type {
  ActiveThemeBitmaps,
  ThemeApproval,
  ThemeBitmapSnapshot,
} from "../../shared/theme-bitmap";
import { themeBitmapSlots } from "../../shared/theme-bitmaps";
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
    set(
      digest: string,
      text: string,
      theme?: { file: string; digest: ThemeApproval },
    ): Promise<void>;
  };
  /** The profile's digest of each interface theme file it last applied, by config path. */
  themeBaseline: {
    get(file: string): ThemeApproval | null;
    set(file: string, value: ThemeApproval | null): Promise<void>;
  };
  applyPlugins?(providers: readonly AgentProvider[]): void;
  /** Catalog only: loading grants no enablement, executable or host authority. */
  applyForges?(plugins: readonly LoadedForgeManifest[]): void;
  confirmArguments?(content: DialogContent): Promise<boolean>;
  acknowledgeBypass?(agents: readonly string[]): Promise<void>;
  onStatus?(status: ConfigStatus): void;
  onThemeDecision?(): void;
  onThemeBitmapsChanged?(): void;
  loadThemeBitmaps?(
    parsed: Extract<ParsedThemeFile, { kind: "theme" }>,
  ): Promise<ThemeBitmapSnapshot>;
  deferThemeDecoding?: boolean;
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
  digest: string;
  bitmaps?: ThemeBitmapSnapshot;
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

const attentionWeakening = {
  action: "use a theme where needs-you is hard to tell apart",
  detail: "attention-distinctness",
};

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
  private publishedBitmaps: string | undefined;
  private appliedThemes = new Map<string, Palette>();
  private heldThemes = new Map<
    string,
    {
      proposal: Palette;
      previous: Palette | undefined;
      settings: string | null;
      id: string;
    }
  >();
  /** Each rejected file: the digest of the bytes rejected and a fixed reason. */
  private rejected = new Map<string, { object: string; reason: string }>();
  private queue: Promise<unknown> = Promise.resolve();
  private watchers = new Map<string, { close(): void }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private available = true;
  private error: string | undefined;
  private notice: string | undefined;
  private closed = false;
  private started = false;
  private deferThemeDecoding: boolean;

  private readonly files: ConfigFiles;
  private readonly plugins: ConfigCatalog;
  constructor(private readonly deps: ConfigServiceDependencies) {
    this.deferThemeDecoding = deps.deferThemeDecoding ?? false;
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

  /** The application calls this after creating its first window. */
  startThemeDecoding(): Promise<ConfigStatus> {
    this.deferThemeDecoding = false;
    return this.refresh();
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
    this.applyLive(this.applied.values);
    // Startup reviews a read-only snapshot before attaching the config writer.
    await this.scan(false);
    this.startWatching();
    this.started = true;
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
      void this.serial(() => this.scanLive()).catch(ignore);
    }, this.deps.delay ?? 250);
  }

  /** Runs one scan now; tests and IPC use it instead of waiting for the watcher. */
  refresh(): Promise<ConfigStatus> {
    return this.serial(async () => {
      await this.scanLive();
      return this.status();
    });
  }

  private reject(file: string, object: string, reason: string): void {
    this.rejected.set(file, { object, reason });
  }

  private async scanLive(): Promise<void> {
    try {
      await this.scan();
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.code !== "settings-busy") throw error;
      this.schedule();
    }
  }

  private async scan(lockSettings = true): Promise<void> {
    if (this.closed) return;
    await this.scanSettings(lockSettings);
    await this.scanPlugins();
    // Known names too, so a removed theme clears its applied, held or rejected state.
    const themes = new Set([
      ...(await this.plugins.themePaths()),
      ...this.appliedThemes.keys(),
      ...this.heldThemes.keys(),
      ...[...this.rejected.keys()].filter((path) => themeKind(path) !== undefined),
    ]);
    for (const relative of [...themes].sort()) await this.scanTheme(relative);
    this.publish();
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
            selection.palette?.digest,
          ])
        : current.text,
    );
    return { ...current, weak, id, selection };
  }

  private async scanSettings(lock = true): Promise<void> {
    const current = await this.readSettings();
    if (!current) return;
    const proposal =
      current.text === this.applied.text ? undefined : await this.inspectSettings(current);
    const apply = async () => {
      if (lock && !(await this.matchesSettings(current, proposal?.selection))) {
        this.schedule();
        return;
      }
      if (!proposal) this.pending = null;
      else if (
        this.deferThemeDecoding &&
        proposal.selection?.palette?.parsed.kind === "theme" &&
        proposal.selection.palette.parsed.images
      )
        await this.applyDeferredSettings(proposal);
      else if (proposal.weak.length) this.pending = proposal;
      else await this.applyValues(proposal, proposal.selection);
    };
    if (lock) await this.files.withSettingsLock(apply);
    else await apply();
  }

  private async applyDeferredSettings(proposal: Pending): Promise<void> {
    // Startup consumers need the safe edits now. Leave the working file intact
    // so the post-window scan reviews its current theme and any held edits.
    let approved = this.applied;
    try {
      approved = this.approvedSettings({
        ...proposal,
        values: this.retainInterfaceTheme(proposal.values),
      });
    } catch (error) {
      // Restoring held fields can make an otherwise valid settings file too large.
      if (!(error instanceof ThemeValidationError) || error.reason !== "too-large") throw error;
    }
    if (approved !== this.applied) await this.applyValues(approved);
    this.pending = proposal.weak.length ? proposal : null;
  }

  private async matchesSettings(settings: Applied, selection?: Selection): Promise<boolean> {
    return (
      (await this.matchesSelection(selection)) &&
      (await this.readSettings())?.text === settings.text
    );
  }

  private async matchesSelection(selection?: Selection): Promise<boolean> {
    if (!selection) return true;
    const bytes = await this.files.read(selection.file).catch(ignore);
    if (!bytes) return selection.source === null && selection.unavailable === (bytes === undefined);
    return selection.source === digest(bytes);
  }

  /** The active palette comes from the same snapshot as the applied selection. */
  activePalette():
    | {
        id: UserThemeId;
        theme: Extract<ParsedThemeFile, { kind: "theme" }>["theme"] | undefined;
        digest?: string;
        bitmaps?: ActiveThemeBitmaps["slots"];
      }
    | undefined {
    const id = effective(this.deps.defaults, this.applied.values).interfaceTheme;
    if (!isUserThemeId(id)) return undefined;
    const file = `themes/${id.slice(5)}`;
    const palette = this.appliedThemes.get(file);
    if (palette?.parsed.kind !== "theme") return { id, theme: undefined };
    const bitmaps: ActiveThemeBitmaps["slots"] = {};
    for (const slot of themeBitmapSlots) {
      const asset = palette.bitmaps?.slots[slot];
      if (asset) bitmaps[slot] = asset.map(({ paint }) => paint);
    }
    return {
      id,
      theme: palette.parsed.theme,
      digest: palette.digest,
      ...(Object.keys(bitmaps).length > 0 && { bitmaps }),
    };
  }

  activeThemeImage(id: string): Uint8Array | undefined {
    const theme = effective(this.deps.defaults, this.applied.values).interfaceTheme;
    if (!isUserThemeId(theme)) return undefined;
    const assets = this.appliedThemes.get(`themes/${theme.slice(5)}`)?.bitmaps?.slots;
    for (const slot of themeBitmapSlots) {
      const asset = assets?.[slot]?.find(({ paint }) => paint.id === id);
      if (asset) return asset.png;
    }
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
    this.notice = undefined;
    this.applyLive(applied.values);
    await this.deps.baseline
      .set(
        digest(applied.text),
        applied.text,
        selection && palette ? { file: selection.file, digest: palette.digest } : undefined,
      )
      .catch(ignore);
  }

  /** Both watchers pass through this serialized gate before a palette reaches any window. */
  reviewTheme(
    file: string,
    text: string,
    parsed: ParsedThemeFile,
  ): Promise<ThemeSnapshot | undefined> {
    return this.serial(async () => {
      // The library reads before joining this queue. A config scan may already
      // have reviewed a newer edit, so an old snapshot must not clear its hold
      // or replace the profile's approval baseline.
      const bytes = await settle(this.files.read(file), null);
      if (bytes && decode(bytes) === text) {
        const candidate = await this.readPalette(text, parsed, this.isActiveTheme(file));
        await this.reviewThemeValue(file, candidate);
        this.publish();
        const snapshot = this.appliedThemes.get(file);
        return (
          snapshot && {
            parsed: snapshot.parsed,
            digest: snapshot.digest,
            ...(candidate.bitmaps && { imageDiagnostics: candidate.bitmaps.diagnostics }),
          }
        );
      }
      const snapshot = this.appliedThemes.get(file);
      if (snapshot)
        return {
          parsed: snapshot.parsed,
          digest: snapshot.digest,
        };
    });
  }

  private isActiveTheme(file: string): boolean {
    return (
      file.startsWith("themes/") &&
      effective(this.deps.defaults, this.applied.values).interfaceTheme ===
        `user:${file.slice("themes/".length)}`
    );
  }

  private async readPalette(
    text: string,
    parsed: ParsedThemeFile,
    active = true,
  ): Promise<Palette> {
    const bitmaps =
      active && !this.deferThemeDecoding && parsed.kind === "theme" && parsed.images
        ? await this.deps.loadThemeBitmaps?.(parsed)
        : undefined;
    return { text, parsed, digest: digest(text), ...(bitmaps && { bitmaps }) };
  }

  private async reviewThemeValue(file: string, candidate: Palette): Promise<void> {
    const { parsed } = candidate;
    if (parsed.kind !== "theme") {
      this.appliedThemes.set(file, candidate);
      return;
    }
    if (!this.isActiveTheme(file)) {
      await this.acceptTheme(file, candidate, false);
      return;
    }
    const previous =
      this.appliedThemes.get(file) ??
      (candidate.digest === this.deps.themeBaseline.get(file) ? candidate : undefined);
    const approved = new Set(
      previous?.parsed.kind === "theme" ? attentionConflicts(previous.parsed.theme) : [],
    );
    if (attentionConflicts(parsed.theme).some((conflict) => !approved.has(conflict))) {
      const settings = await settle(this.files.read(SETTINGS_FILE), null);
      const settingsDigest = settings && digest(settings);
      this.heldThemes.set(file, {
        proposal: candidate,
        previous,
        settings: settingsDigest,
        id: digest(JSON.stringify([settingsDigest, file, candidate.digest])),
      });
      await this.refreshActiveArt(file);
      return;
    }
    await this.acceptTheme(file, candidate, true);
  }

  private async refreshActiveArt(file: string): Promise<void> {
    const previous = this.appliedThemes.get(file);
    if (!this.isActiveTheme(file) || previous?.parsed.kind !== "theme" || !previous.parsed.images)
      return;
    this.appliedThemes.set(file, await this.readPalette(previous.text, previous.parsed));
  }

  private async acceptTheme(file: string, candidate: Palette, active: boolean): Promise<void> {
    this.heldThemes.delete(file);
    this.appliedThemes.set(file, candidate);
    if (!active) return;
    try {
      await this.deps.themeBaseline.set(file, candidate.digest);
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
        const parsed = parseThemeFile(text, "theme");
        const palette = await this.readPalette(text, parsed);
        return { file, source, palette, unavailable: false };
      }
    } catch {
      return { file, source, palette: this.appliedThemes.get(file), unavailable: true };
    }
    return { file, source, palette: this.appliedThemes.get(file), unavailable: false };
  }

  private themeSelectionWeakening(selection?: Selection): Weakening[] {
    const weak: Weakening[] = [];
    const parsed = selection?.palette?.parsed;
    if (
      parsed?.kind === "theme" &&
      parsed.warnings?.some((warning) => warning.reason === "attention-distinctness")
    )
      weak.push({
        field: ["interfaceTheme"],
        ...attentionWeakening,
        detail: "interfaceTheme: attention-distinctness",
      });
    if (selection?.unavailable)
      weak.push({
        field: ["interfaceTheme"],
        action: "use a theme whose needs-you colors could not be checked",
        detail: "interfaceTheme: palette unavailable",
      });
    return weak;
  }

  private async scanTheme(relative: string): Promise<void> {
    const kind = themeKind(relative);
    if (!kind) return;
    let bytes: Buffer | null;
    try {
      bytes = await this.files.read(relative);
    } catch (error) {
      this.heldThemes.delete(relative);
      await this.refreshActiveArt(relative);
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
      await this.reviewThemeValue(
        relative,
        await this.readPalette(text, parseThemeFile(text, kind), this.isActiveTheme(relative)),
      );
    } catch (error) {
      this.heldThemes.delete(relative);
      await this.refreshActiveArt(relative);
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
              action: attentionWeakening.action,
              detail: attentionWeakening.detail,
            }
          : null,
      rejected,
      ...(this.error ? { error: this.error } : {}),
      ...(this.notice ? { notice: this.notice } : {}),
    };
  }

  private publish(): void {
    if (this.closed) return;
    this.deps.onStatus?.(this.status());
    const active = this.activePalette();
    const projected = active?.bitmaps ? JSON.stringify([active.id, active.bitmaps]) : undefined;
    if (projected !== this.publishedBitmaps) {
      this.publishedBitmaps = projected;
      this.deps.onThemeBitmapsChanged?.();
    }
  }

  /** Settings UI writes go through the same file. */
  write(patch: ConfigSettings, themeDigest?: string): Promise<void> {
    return this.serial(async () => {
      const before = effective(this.deps.defaults, this.applied.values);
      const requested = patch.interfaceTheme;
      const explicit = requested !== undefined;
      const offered = explicit ? (themeDigest ?? null) : undefined;
      const chosen = explicit
        ? await this.readSelection(before.interfaceTheme, requested)
        : undefined;
      // Cooperating profiles may replace settings while the decoder is running.
      // Plan again from their latest file, with a bounded number of attempts.
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await this.readSettings();
        const proposal = current ? await this.inspectSettings(current) : null;
        const committed = await this.files.withSettingsLock(async () => {
          if (current && !(await this.matchesSettings(current, proposal?.selection))) return false;
          await this.writeSettingsLocked(
            patch,
            proposal,
            explicit ? chosen : proposal?.selection,
            offered,
          );
          return true;
        });
        if (committed) {
          await this.reconcileSettings();
          this.publish();
          return;
        }
      }
      throw new ApplicationError("settings-busy");
    });
  }

  private async writeSettingsLocked(
    patch: ConfigSettings,
    proposal: Pending | null,
    selection?: Selection,
    offered?: string | null,
  ): Promise<void> {
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
    await this.commitSettings(next, approved, selection, offered);
  }

  private async reconcileSettings(): Promise<void> {
    if ((await this.readSettings())?.text === this.applied.text) return;
    try {
      await this.scanSettings();
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.code !== "settings-busy") throw error;
      this.schedule();
    }
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

  private retainInterfaceTheme(values: ConfigSettings): ConfigSettings {
    const retained = { ...values };
    const { interfaceTheme } = this.applied.values;
    if (interfaceTheme === undefined) delete retained.interfaceTheme;
    else retained.interfaceTheme = interfaceTheme;
    return retained;
  }

  private async commitSettings(
    next: Applied,
    approved: Applied,
    selection?: Selection,
    offeredThemeDigest?: string | null,
  ): Promise<void> {
    const before = effective(this.deps.defaults, this.applied.values);
    const after = effective(this.deps.defaults, approved.values);
    let reviewed: Selection | undefined;
    let fallback: Applied | undefined;
    if (before.interfaceTheme !== after.interfaceTheme && isUserThemeId(after.interfaceTheme)) {
      reviewed = selection;
      if (offeredThemeDigest !== undefined) {
        if (
          offeredThemeDigest === null ||
          !reviewed?.source ||
          reviewed.unavailable ||
          !reviewed.palette ||
          reviewed.palette.digest !== offeredThemeDigest ||
          !(await this.matchesSelection(reviewed))
        )
          throw new ApplicationError("theme-selection-changed");
      }
      fallback = this.settingsFile(this.retainInterfaceTheme(approved.values));
    }
    await this.files.writeFile(SETTINGS_FILE, next.text);
    // Palette writers do not take the settings lock. A replacement during the
    // rename stays a proposal, and is decoded after this lock is released.
    if (fallback && (!reviewed || !(await this.matchesSelection(reviewed)))) {
      approved = fallback;
      reviewed = undefined;
    }
    await this.applyValues(approved, reviewed);
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
      const current = await this.matchSettings(pending);
      if (
        !current ||
        !(await this.files.withSettingsLock(() => this.matchesSettings(current, current.selection)))
      )
        await this.changedProposal();
      if (!(await this.deps.confirmArguments?.(argumentDisclosure(before, after)))) return;
    }
    const current = await this.matchSettings(pending);
    const committed = await this.files.withSettingsLock(async () => {
      if (!current || !(await this.matchesSettings(current, current.selection))) return false;
      if (decision === "keep") {
        await this.keepSettings(current);
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
          if (!(await this.matchesSettings(current, current.selection))) return false;
        }
      }
      await this.applyValues(current, current.selection);
      return true;
    });
    if (!committed) await this.changedProposal();
    else if (decision === "keep") await this.reconcileSettings();
  }

  private async keepSettings(current: Pending): Promise<void> {
    try {
      const approved = this.approvedSettings(current);
      // commitSettings serializes any defensive palette fallback before replacing the file.
      await this.commitSettings(approved, approved, current.selection);
      return;
    } catch (error) {
      if (!(error instanceof ThemeValidationError) || error.reason !== "too-large") throw error;
    }
    await this.commitSettings(this.applied, this.applied);
    this.notice =
      "Restored the last approved settings. Other edits were dropped because they exceeded 64 KiB when combined.";
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
    const text = proposal.proposal.text;
    const expected = Buffer.from(text);
    const fresh = await this.readPalette(text, proposal.proposal.parsed);
    const previous = proposal.previous;
    const committed = await this.files.withSettingsLock(async () => {
      const current = await this.readSettings();
      const matches = async () =>
        (await settle(this.files.read(file), null))?.equals(expected) === true;
      if (
        !current ||
        digest(current.text) !== proposal.settings ||
        effective(this.deps.defaults, current.values).interfaceTheme !== `user:${file.slice(7)}` ||
        !(await matches())
      )
        return false;
      if (decision === "keep" && previous) {
        if (!(await this.files.writeFile(file, previous.text, expected))) return false;
      } else {
        if (!(await matches())) return false;
        if (decision === "allow") await this.acceptTheme(file, fresh, true);
        else
          await this.writeSettingsLocked(
            { interfaceTheme: this.deps.defaults.interfaceTheme },
            await this.inspectSettings(current),
          );
      }
      this.heldThemes.delete(file);
      return true;
    });
    if (!committed) await this.changedProposal();
    this.schedule();
  }

  private async changedProposal(): Promise<never> {
    await this.scanLive();
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
