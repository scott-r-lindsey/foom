import { randomUUID } from "node:crypto";
import { constants, watch } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConfigSettings } from "../../shared/config";
import { parseSettingsFile } from "../../shared/config-files";
import type { ConfigChange, ConfigStatus } from "../../shared/foom-config";
import { SOUND_KINDS } from "../../shared/sounds";
import type { ThemeKind } from "../../shared/theme-file";
import { parseThemeFile } from "../../shared/theme-files";
import { ThemeValidationError, validThemeFile } from "../../shared/theme-validation";
import { describe, effective, weakenings } from "./approval";
import type { EffectiveConfig, Weakening } from "./approval";
import type { CommitRecord, ConfigGit, TreeEntry } from "./git";
import { OWNED_FILES, SETTINGS_FILE, THEME_FOLDERS, digest, refreshable } from "./layout";

const MAX_FILE = 65536;
const MAX_THEMES = 50;
const MAX_EVENTS = 20;

export interface ConfigServiceDependencies {
  root: string;
  git: Pick<
    ConfigGit,
    "exists" | "init" | "head" | "objectId" | "tree" | "blob" | "commit" | "log" | "changes"
  >;
  defaults: EffectiveConfig;
  /** Pushes validated values into the running app. */
  apply(values: ConfigSettings): void;
  /** The profile's digest of the settings file it last applied: the approval baseline. */
  baseline: { get(): string | null; set(value: string): Promise<void> };
  onStatus?(status: ConfigStatus): void;
  now?: () => number;
  watch?: (directory: string, listener: (file: string | null) => void) => { close(): void };
  delay?: number;
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
  return error instanceof ThemeValidationError ? `${error.path}: ${error.reason}` : "$: unreadable";
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

/** Paths Foom validates, applies and commits on its own. */
export function revertable(path: string): boolean {
  return path === SETTINGS_FILE || themeKind(path) !== undefined;
}

/**
 * The Foom config folder: validates changes, applies safe ones live, holds changes that
 * weaken attention for approval, and records applied changes as commits in its
 * hardened git repository.
 */
export class ConfigService {
  private applied: Applied = DEFAULTS;
  private pending: Pending | null = null;
  private events: ConfigChange[] = [];
  private rejected = new Map<string, string>();
  private history: CommitRecord[] = [];
  /** When this process made each commit; git records whole seconds only. */
  private commitTimes = new Map<string, number>();
  private revertSubjects = new Map<string, { object: string | null; subject: string }>();
  private queue: Promise<unknown> = Promise.resolve();
  private watchers = new Map<string, { close(): void }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private available = true;
  private error: string | undefined;
  private uncommitted: number | null = null;
  private closed = false;
  private started = false;

  constructor(private readonly deps: ConfigServiceDependencies) {}

  get folder(): string {
    return this.deps.root;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
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
      await rename(temporary, target);
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
      ...SOUND_KINDS.map((kind) => `sounds/${kind}`),
    ])
      await mkdir(this.path(folder), { recursive: true });
    const written: string[] = [];
    for (const [relative, content] of Object.entries(OWNED_FILES)) {
      const current = await this.read(relative).catch(ignore);
      if (current !== undefined && refreshable(relative, current)) {
        await this.writeFile(relative, content);
        written.push(relative);
      }
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
        } catch {
          // Dropped; the default applies.
        }
      }
      const text = `${JSON.stringify({ kind: "settings", ...values }, null, 2)}\n`;
      await this.writeFile(SETTINGS_FILE, text);
      migrated = { text, values };
    }
    await this.initializeRepository(written);
    this.applied = (await this.baseline(migrated)) ?? DEFAULTS;
    if (migrated && this.applied === migrated) await this.deps.baseline.set(digest(migrated.text));
    this.deps.apply(this.applied.values);
    await this.scan();
    this.startWatching();
    this.started = true;
    return this.applied.values;
  }

  private async initializeRepository(written: readonly string[]): Promise<void> {
    try {
      if (!(await this.deps.git.exists())) {
        await this.deps.git.init();
        const files = new Map<string, Uint8Array>();
        for (const relative of [...Object.keys(OWNED_FILES), ...(await this.themePaths())]) {
          const bytes = await settle(this.read(relative), null);
          if (bytes && (themeKind(relative) === undefined || this.validTheme(relative, bytes)))
            files.set(relative, bytes);
        }
        const settings = await settle(this.read(SETTINGS_FILE), null);
        if (settings && this.validSettings(settings)) files.set(SETTINGS_FILE, settings);
        await this.deps.git.commit(files, "Initialize Foom config");
      } else if (written.length) {
        const files = new Map<string, Uint8Array>();
        for (const relative of written)
          files.set(relative, Buffer.from(OWNED_FILES[relative] ?? ""));
        await this.deps.git.commit(files, "Update Foom config docs");
      }
    } catch {
      this.available = false;
      this.error = "Git is unavailable. Changes apply but are not recorded.";
    }
  }

  private validSettings(bytes: Uint8Array): boolean {
    try {
      parseSettingsFile(decode(bytes));
      return true;
    } catch {
      return false;
    }
  }

  private validTheme(relative: string, bytes: Uint8Array): boolean {
    const kind = themeKind(relative);
    if (!kind) return false;
    try {
      parseThemeFile(decode(bytes), kind);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * What this profile last applied. The working file counts only if its digest matches;
   * otherwise the last commit, if it matches. Anything else is unverified and is
   * compared against the defaults, so an off switch made while Foom was closed is held.
   */
  private async baseline(migrated?: Applied): Promise<Applied | undefined> {
    if (migrated) return migrated;
    const known = this.deps.baseline.get();
    if (!known) return undefined;
    const candidates: Uint8Array[] = [];
    const working = await settle(this.read(SETTINGS_FILE), null);
    if (working) candidates.push(working);
    const committed = await this.committed(SETTINGS_FILE);
    if (committed) candidates.push(committed);
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

  private async headTree(): Promise<Map<string, TreeEntry>> {
    if (!this.available) return new Map();
    const head = await this.deps.git.head();
    return head ? this.deps.git.tree(head) : new Map();
  }

  private async committed(relative: string): Promise<Buffer | null> {
    try {
      const entry = (await this.headTree()).get(relative);
      return entry ? await this.deps.git.blob(entry.object) : null;
    } catch {
      return null;
    }
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
      const replaced = Object.values(THEME_FOLDERS).find((folder) => folder === file);
      // A theme folder that was removed and recreated needs a new subscription.
      if (replaced) this.watchFolder(replaced);
      return file === null || file === SETTINGS_FILE || replaced !== undefined;
    });
    for (const folder of Object.values(THEME_FOLDERS)) this.watchFolder(folder);
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

  private record(change: Omit<ConfigChange, "id" | "time">): void {
    this.events = [{ ...change, id: randomUUID(), time: this.now() }, ...this.events].slice(
      0,
      MAX_EVENTS,
    );
  }

  private reject(file: string, object: string, reason: string): void {
    if (this.rejected.get(file) === object) return;
    this.rejected.set(file, object);
    this.record({ summary: `Rejected ${file}`, file, state: "rejected", reason });
  }

  private async scan(): Promise<void> {
    if (this.closed) return;
    const tree = await settle(this.headTree(), new Map<string, TreeEntry>());
    await this.scanSettings(tree);
    const themes = new Set([
      ...(await this.themePaths()),
      ...[...tree.keys()].filter((path) => themeKind(path) !== undefined),
    ]);
    for (const relative of [...themes].sort()) await this.scanTheme(relative, tree);
    await this.countUncommitted();
    this.publish();
  }

  private async scanSettings(tree: Map<string, TreeEntry>): Promise<void> {
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
    const object = await this.deps.git.objectId(bytes);
    let text: string;
    let values: ConfigSettings;
    try {
      text = decode(bytes);
      if (text === this.applied.text) {
        this.rejected.delete(SETTINGS_FILE);
        if (this.pending) {
          this.pending = null;
          this.events = this.events.filter((event) => event.state !== "pending");
        }
        // An applied change whose commit failed, or a commit rewritten underneath it, is
        // recorded again without waiting for another edit.
        const entry = tree.get(SETTINGS_FILE);
        if (this.available && entry?.object !== object) {
          let recorded: ConfigSettings = {};
          if (entry)
            try {
              recorded = parseSettingsFile(decode(await this.deps.git.blob(entry.object)));
            } catch {
              // An unreadable or invalid commit compares as the defaults.
            }
          await this.commitSettings(recorded, tree);
        }
        return;
      }
      values = parseSettingsFile(text);
    } catch (error) {
      this.reject(SETTINGS_FILE, object, invalid(error));
      return;
    }
    this.rejected.delete(SETTINGS_FILE);
    const before = effective(this.deps.defaults, this.applied.values);
    const after = effective(this.deps.defaults, values);
    const weak = weakenings(before, after);
    if (weak.length) {
      if (this.pending?.text === text) return;
      this.events = this.events.filter((event) => event.state !== "pending");
      this.pending = { text, values, weak };
      this.record({ summary: describe(before, after), file: SETTINGS_FILE, state: "pending" });
      return;
    }
    await this.apply(text, values, tree);
  }

  /** Applies validated settings, records the baseline, then commits if HEAD differs. */
  private async apply(
    text: string,
    values: ConfigSettings,
    tree: Map<string, TreeEntry>,
    subject?: string,
  ): Promise<void> {
    const before = this.applied.values;
    await this.applyValues(text, values);
    await this.commitSettings(before, tree, subject);
  }

  private async applyValues(text: string, values: ConfigSettings): Promise<void> {
    this.deps.apply(values);
    this.applied = { text, values };
    if (this.pending) {
      this.pending = null;
      this.events = this.events.filter((event) => event.state !== "pending");
    }
    await this.deps.baseline.set(digest(text)).catch(ignore);
  }

  /** Commits the applied settings file when it differs from the last commit. */
  private async commitSettings(
    previous: ConfigSettings,
    tree: Map<string, TreeEntry>,
    subject?: string,
    { text, values }: Applied = this.applied,
  ): Promise<void> {
    const before = effective(this.deps.defaults, previous);
    const after = effective(this.deps.defaults, values);
    const bytes = Buffer.from(text);
    const object = await this.deps.git.objectId(bytes);
    if (tree.get(SETTINGS_FILE)?.object === object) return;
    const revert = this.revertSubjects.get(SETTINGS_FILE);
    this.revertSubjects.delete(SETTINGS_FILE);
    await this.commit(
      new Map([[SETTINGS_FILE, bytes]]),
      subject ?? (revert?.object === object ? revert.subject : describe(before, after)),
    );
  }

  private async commit(files: Map<string, Uint8Array | null>, subject: string): Promise<void> {
    if (!this.available) return;
    try {
      this.commitTimes.set(await this.deps.git.commit(files, subject), this.now());
      this.error = undefined;
    } catch {
      this.error = "Unable to record the last change in git.";
    }
  }

  private async scanTheme(relative: string, tree: Map<string, TreeEntry>): Promise<void> {
    const kind = themeKind(relative);
    if (!kind) return;
    const entry = tree.get(relative);
    let bytes: Buffer | null;
    try {
      bytes = await this.read(relative);
    } catch (error) {
      this.reject(relative, invalid(error), invalid(error));
      return;
    }
    const revert = this.revertSubjects.get(relative);
    if (bytes === null) {
      this.rejected.delete(relative);
      if (!entry) return;
      this.revertSubjects.delete(relative);
      await this.commit(
        new Map([[relative, null]]),
        revert && revert.object === null ? revert.subject : `Remove ${relative}`,
      );
      return;
    }
    const object = await this.deps.git.objectId(bytes);
    if (entry?.object === object) {
      this.rejected.delete(relative);
      return;
    }
    let name: string;
    try {
      const parsed = parseThemeFile(decode(bytes), kind);
      name = parsed.kind === "theme" ? parsed.theme.name : parsed.name;
    } catch (error) {
      this.reject(relative, object, invalid(error));
      return;
    }
    this.rejected.delete(relative);
    this.revertSubjects.delete(relative);
    const noun = kind === "theme" ? `${name} theme` : `${name} terminal colors`;
    await this.commit(
      new Map([[relative, bytes]]),
      revert?.object === object ? revert.subject : `${entry ? "Update" : "Add"} ${noun}`,
    );
  }

  /** Uncommitted files in Foom's layout: owned files, settings and theme files. */
  private async countUncommitted(): Promise<void> {
    if (!this.available) {
      this.uncommitted = null;
      return;
    }
    try {
      const tree = await this.headTree();
      const paths = new Set([
        ...Object.keys(OWNED_FILES),
        SETTINGS_FILE,
        ...(await this.themePaths()),
        ...[...tree.keys()].filter((path) => revertable(path) || path in OWNED_FILES),
      ]);
      let count = 0;
      for (const relative of paths) {
        const bytes = await this.read(relative).catch(ignore);
        const entry = tree.get(relative);
        if (bytes === undefined) count++;
        else if (bytes === null) count += entry ? 1 : 0;
        else if (entry?.object !== (await this.deps.git.objectId(bytes))) count++;
      }
      this.uncommitted = count;
      this.history = await this.deps.git.log(MAX_EVENTS);
    } catch {
      this.uncommitted = null;
    }
  }

  status(): ConfigStatus {
    const applied: ConfigChange[] = this.history.map((entry) => ({
      id: entry.commit,
      time: this.commitTimes.get(entry.commit) ?? entry.time,
      summary: entry.subject,
      file: entry.files.join(", "),
      state: "applied",
      commit: entry.commit,
      hash: entry.commit.slice(0, 7),
    }));
    const pending = this.pending;
    return {
      folder: this.deps.root,
      available: this.available,
      uncommitted: this.uncommitted,
      pending: pending
        ? {
            action: pending.weak.map((entry) => entry.action).join(" and "),
            file: SETTINGS_FILE,
            detail: pending.weak.map((entry) => entry.detail).join(", "),
          }
        : null,
      changes: [...this.events, ...applied].sort((a, b) => b.time - a.time).slice(0, MAX_EVENTS),
      rejected: this.rejected.size,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private publish(): void {
    if (!this.closed) this.deps.onStatus?.(this.status());
  }

  /** Settings UI writes go through the same file, so they appear in Recent changes too. */
  write(patch: ConfigSettings): Promise<void> {
    return this.serial(async () => {
      const text = `${JSON.stringify({ kind: "settings", ...this.applied.values, ...patch }, null, 2)}\n`;
      let values: ConfigSettings;
      try {
        values = parseSettingsFile(text);
      } catch {
        throw new Error("This setting cannot be stored in the Foom config folder");
      }
      if (this.pending) {
        this.record({
          summary: "Held change replaced in Settings",
          file: SETTINGS_FILE,
          state: "rejected",
          reason: "Replaced by a change in Settings",
        });
      }
      await this.writeFile(SETTINGS_FILE, text);
      const previous = this.applied.values;
      await this.applyValues(text, values);
      // Settings responds once the file is written and applied; the commit follows in
      // order, from this write's own snapshot.
      void this.serial(async () => {
        await this.commitSettings(
          previous,
          await settle(this.headTree(), new Map<string, TreeEntry>()),
          undefined,
          { text, values },
        );
        await this.countUncommitted();
        this.publish();
      }).catch(ignore);
    });
  }

  /** Allow applies the held change and commits it; keep restores the applied file. */
  decide(decision: unknown): Promise<ConfigStatus> {
    if (decision !== "allow" && decision !== "keep")
      return Promise.reject(new Error("Invalid decision"));
    return this.serial(async () => {
      const pending = this.pending;
      if (!pending) throw new Error("No change is waiting for approval");
      const bytes = await settle(this.read(SETTINGS_FILE), null);
      if (!bytes || bytes.toString("utf8") !== pending.text) {
        await this.scan();
        throw new Error("The file changed. Review the new change.");
      }
      const tree = await settle(this.headTree(), new Map<string, TreeEntry>());
      if (decision === "allow") await this.apply(pending.text, pending.values, tree);
      else {
        this.pending = null;
        this.events = this.events.filter((event) => event.state !== "pending");
        this.record({
          summary: `Kept on: ${pending.weak.map((entry) => entry.detail).join(", ")}`,
          file: SETTINGS_FILE,
          state: "rejected",
          reason: "Declined in Settings",
        });
        const committed = await this.committed(SETTINGS_FILE);
        const restore =
          committed && committed.toString("utf8") === this.applied.text
            ? committed
            : Buffer.from(this.applied.text);
        await this.writeFile(SETTINGS_FILE, restore);
        const object = await this.deps.git.objectId(restore);
        if (tree.get(SETTINGS_FILE)?.object !== object)
          await this.commit(new Map([[SETTINGS_FILE, restore]]), "Restore settings");
      }
      await this.countUncommitted();
      this.publish();
      return this.status();
    });
  }

  /**
   * Restores each path of a listed commit to its parent's version, then validates the
   * result like any other change. Plumbing replaces `git revert`, whose merge machinery
   * can run repository-configured merge drivers and checkout filters.
   */
  revert(commit: unknown): Promise<ConfigStatus> {
    return this.serial(async () => {
      if (typeof commit !== "string" || !this.history.some((entry) => entry.commit === commit))
        throw new Error("Choose a change from Recent changes");
      const record = this.history.find((entry) => entry.commit === commit);
      const changes = await this.deps.git.changes(commit);
      if (
        !changes.length ||
        !changes.every(
          (change) =>
            revertable(change.path) && (change.path !== SETTINGS_FILE || change.before !== null),
        )
      )
        throw new Error("Only settings and theme changes can be reverted");
      for (const change of changes) {
        const bytes = await this.read(change.path).catch(ignore);
        if (bytes === undefined) throw new Error(`${change.path} is unreadable`);
        const current = bytes === null ? null : await this.deps.git.objectId(bytes);
        if (current !== change.after) throw new Error(`${change.path} changed after this change`);
      }
      for (const change of changes) {
        this.revertSubjects.set(change.path, {
          object: change.before,
          subject: `Revert "${record?.subject ?? commit.slice(0, 7)}"`,
        });
        if (change.before === null) {
          if (!(await this.contained(dirname(change.path))))
            throw new Error("A Foom config folder is redirected outside the config folder");
          await rm(this.path(change.path), { force: true });
        } else await this.writeFile(change.path, await this.deps.git.blob(change.before));
      }
      await this.scan();
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
