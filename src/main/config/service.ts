import { parseAgentManifest } from "../../shared/agent-plugin-parser";
import { AgentManifestError } from "../../shared/agent-manifest";
import type { AgentPluginManifest } from "../../shared/agent-plugin";
import type { AgentManifestV2 } from "../../shared/agent-manifest-v2";
import { v2Provider, availableV2 } from "../agents/providers/v2";
import type { AgentProvider } from "../agents/providers/registry";
import { configProvider } from "../agents/providers/config";
import { pluginDisclosure } from "../agents/providers/disclosure";
import { randomUUID } from "node:crypto";
import { constants, watch } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hasBypassArgument, parseAgentDefaults } from "../agents/default-arguments";
import type { DialogContent } from "../../shared/confirmation";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConfigSettings } from "../../shared/config";
import { parseSettingsFile } from "../../shared/config-files";
import type { ConfigChange, ConfigStatus } from "../../shared/foom-config";
import { SOUND_KINDS } from "../../shared/sounds";
import type { ParsedThemeFile, ThemeDiagnostic, ThemeKind } from "../../shared/theme-file";
import { parseThemeFile } from "../../shared/theme-files";
import { attentionConflicts } from "../../shared/user-interface-theme";
import { ThemeValidationError, validThemeFile } from "../../shared/theme-validation";
import { argumentChanges, argumentDisclosure, describe, effective, weakenings } from "./approval";
import type { EffectiveConfig, Weakening } from "./approval";
import { RedirectedGitError } from "./git";
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
  /** The profile's digest of each interface theme file it last applied, by config path. */
  themeBaseline: {
    get(file: string): string | null;
    set(file: string, value: string | null): Promise<void>;
  };
  pluginBaseline?: {
    get(file: string): string | null;
    set(file: string, value: string | null): Promise<void>;
  };
  applyPlugins?(providers: readonly AgentProvider[]): void;
  confirmPlugin?(content: DialogContent): Promise<boolean>;
  confirmArguments?(content: DialogContent): Promise<boolean>;
  acknowledgeBypass?(agents: readonly ("claude" | "codex" | "agy")[]): Promise<void>;
  onStatus?(status: ConfigStatus): void;
  onThemeDecision?(): void;
  now?: () => number;
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

function createConfigProvider(
  manifest: AgentPluginManifest | AgentManifestV2,
  validate: () => Promise<void>,
): AgentProvider {
  return manifest.version === 2
    ? v2Provider(manifest, validate)
    : configProvider(manifest, validate);
}

/** Paths Foom validates, applies and commits on its own. */
export function revertable(path: string): boolean {
  return (
    path === SETTINGS_FILE ||
    themeKind(path) !== undefined ||
    /^agents\/[a-z][a-z0-9-]{0,39}\.json$/u.test(path)
  );
}

/**
 * The Foom config folder: validates changes, applies safe ones live, holds changes that
 * weaken attention for approval, and records applied changes as commits in its
 * hardened git repository.
 */
export class ConfigService {
  private applied: Applied = DEFAULTS;
  private pending: Pending | null = null;
  private heldPlugins = new Map<
    string,
    { text: string; manifest: AgentPluginManifest | AgentManifestV2; previous: string | null }
  >();
  private approvedPlugins = new Map<string, { text: string; provider: AgentProvider }>();
  private events: ConfigChange[] = [];
  private appliedThemes = new Map<string, { text: string; parsed: ParsedThemeFile }>();
  private heldThemes = new Map<string, { text: string; previous: string | null }>();
  private commitWarnings = new Map<string, readonly ThemeDiagnostic[]>();
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
      "agents",
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
    await this.initializeRepository(written);
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
      const working = await this.read(SETTINGS_FILE);
      if (!working || decode(working) !== this.applied.text)
        await this.deps.git.commit(
          new Map([[SETTINGS_FILE, Buffer.from(this.applied.text)]]),
          "Migrate agent launch arguments",
        );
      await this.deps.baseline.set(digest(this.applied.text));
    }
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
    } catch (error) {
      this.available = false;
      this.error =
        error instanceof RedirectedGitError
          ? error.message
          : "Git is unavailable. Changes apply but are not recorded.";
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
      const replaced = [...Object.values(THEME_FOLDERS), "agents"].find(
        (folder) => folder === file,
      );
      // A theme folder that was removed and recreated needs a new subscription.
      if (replaced) this.watchFolder(replaced);
      return file === null || file === SETTINGS_FILE || replaced !== undefined;
    });
    for (const folder of [...Object.values(THEME_FOLDERS), "agents"]) this.watchFolder(folder);
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
    await this.scanPlugins(tree);
    const themes = new Set([
      ...(await this.themePaths()),
      ...[...tree.keys()].filter((path) => themeKind(path) !== undefined),
    ]);
    for (const relative of [...themes].sort()) await this.scanTheme(relative, tree);
    await this.countUncommitted();
    this.publish();
  }

  private async removePluginFile(file: string): Promise<void> {
    if (!(await this.contained("agents")))
      throw new Error("A Foom config folder is redirected outside the config folder");
    await rm(this.path(file), { force: true });
  }

  private async pluginPaths(): Promise<string[]> {
    if (!(await this.contained("agents"))) return [];
    const names = await readdir(this.path("agents")).catch(() => []);
    return names
      .filter((name) => /^[a-z][a-z0-9-]{0,39}\.json$/u.test(name))
      .sort()
      .slice(0, 50)
      .map((name) => `agents/${name}`);
  }

  private async scanPlugins(tree: Map<string, TreeEntry>): Promise<void> {
    const paths = new Set([
      ...(await this.pluginPaths()),
      ...this.approvedPlugins.keys(),
      ...this.heldPlugins.keys(),
      ...[...tree.keys()].filter((file) => /^agents\/[a-z][a-z0-9-]{0,39}\.json$/u.test(file)),
    ]);
    const active: AgentProvider[] = [];
    for (const file of paths) {
      let bytes: Buffer | null;
      try {
        bytes = await this.read(file);
      } catch {
        this.approvedPlugins.delete(file);
        this.heldPlugins.delete(file);
        this.reject(file, "unreadable", "$: unsafe-file");
        continue;
      }
      if (!bytes) {
        this.approvedPlugins.delete(file);
        this.heldPlugins.delete(file);
        this.rejected.delete(file);
        await this.deps.pluginBaseline?.set(file, null);
        if (tree.has(file)) await this.commit(new Map([[file, null]]), `Remove ${file}`);
        continue;
      }
      let text: string;
      let manifest: AgentPluginManifest | AgentManifestV2;
      try {
        text = decode(bytes);
        const parsed = parseAgentManifest(text);
        if (parsed.version === 2) availableV2(parsed.model);
        manifest = parsed.version === 2 ? parsed.model : parsed.manifest;
        if (file !== `agents/${manifest.id}.json`)
          throw new AgentManifestError("$.id", "filename-mismatch");
      } catch (error) {
        this.approvedPlugins.delete(file);
        this.heldPlugins.delete(file);
        this.reject(
          file,
          digest(bytes),
          error instanceof AgentManifestError ? error.message : "$: invalid-manifest",
        );
        continue;
      }
      this.rejected.delete(file);
      const previous = this.approvedPlugins.get(file);
      if (this.deps.pluginBaseline?.get(file) !== digest(text)) {
        let restore = previous?.text ?? this.heldPlugins.get(file)?.previous ?? null;
        if (!restore) {
          const committed = await this.committed(file);
          if (
            committed &&
            digest(committed.toString("utf8")) === this.deps.pluginBaseline?.get(file)
          )
            restore = decode(committed);
        }
        this.heldPlugins.set(file, { text, manifest, previous: restore });
        this.approvedPlugins.delete(file);
        continue;
      }
      const provider =
        previous?.text === text
          ? previous.provider
          : createConfigProvider(manifest, async () => {
              const current = await this.read(file);
              if (
                !current ||
                digest(current) !== digest(text) ||
                this.deps.pluginBaseline?.get(file) !== digest(text)
              )
                throw new Error("Agent plugin changed. Review it again.");
            });
      this.approvedPlugins.set(file, { text, provider });
      this.heldPlugins.delete(file);
      active.push(provider);
      if (tree.get(file)?.object !== (await this.deps.git.objectId(bytes)))
        await this.commit(new Map([[file, bytes]]), `Approve ${manifest.name} agent plugin`);
    }
    this.deps.applyPlugins?.(active);
  }

  private async decidePlugin(decision: "allow" | "keep", id: unknown): Promise<ConfigStatus> {
    const held = [...this.heldPlugins.entries()].find(
      ([file, proposal]) => digest(file + proposal.text) === id,
    );
    if (!held)
      throw new Error(
        this.heldPlugins.size
          ? "The change was replaced. Review it again."
          : "No change is waiting for approval",
      );
    const [file, proposal] = held;
    if (id !== digest(file + proposal.text))
      throw new Error("The change was replaced. Review it again.");
    const check = async () => {
      const bytes = await this.read(file);
      if (!bytes || decode(bytes) !== proposal.text) {
        await this.scan();
        throw new Error("The file changed. Review the new change.");
      }
    };
    await check();
    if (decision === "allow") {
      if (
        !(await this.deps.confirmPlugin?.(
          pluginDisclosure(proposal.manifest, {
            file,
            digest: digest(proposal.text),
            text: proposal.text,
            previous: proposal.previous,
          }),
        ))
      )
        return this.status();
      await check();
      if (!this.deps.pluginBaseline) throw new Error("Agent approval storage is unavailable");
      await this.deps.pluginBaseline.set(file, digest(proposal.text));
    } else {
      if (proposal.previous === null) await this.removePluginFile(file);
      else await this.writeFile(file, proposal.previous);
    }
    this.heldPlugins.delete(file);
    await this.scan();
    return this.status();
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
    const weak = [
      ...weakenings(before, after),
      ...argumentChanges(before, after),
      ...(await this.themeSelectionWeakening(before, after)),
    ];
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
    } catch (error) {
      this.error =
        error instanceof RedirectedGitError
          ? error.message
          : "Unable to record the last change in git.";
    }
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
    // Agents can commit in this folder, so a commit alone is never an approval baseline:
    // only the version this profile last applied, matched by the digest it keeps.
    let previous = this.appliedThemes.get(file);
    let committed: { text: string; parsed: ParsedThemeFile } | undefined;
    if (!previous) {
      const bytes = await this.committed(file);
      if (bytes)
        try {
          const oldText = decode(bytes);
          committed = { text: oldText, parsed: parseThemeFile(oldText, kind) };
          if (digest(bytes) === this.deps.themeBaseline.get(file)) previous = committed;
        } catch {
          /* Invalid history is never an approval baseline. */
        }
    }
    const conflicts = (value: ParsedThemeFile | undefined) =>
      value?.kind === "theme" ? attentionConflicts(value.theme) : [];
    const approved = new Set(conflicts(previous?.parsed));
    const active = effective(this.deps.defaults, this.applied.values).interfaceTheme;
    if (
      active === `user:${file.slice("themes/".length)}` &&
      conflicts(parsed).some((conflict) => !approved.has(conflict))
    ) {
      // Keep it on restores a version with no conflicts: the approved one, or an
      // unapproved commit that is safe anyway. Without one it leaves the theme instead.
      const safe = committed && conflicts(committed.parsed).length === 0 ? committed.text : null;
      this.heldThemes.set(file, { text, previous: previous?.text ?? safe });
      if (previous) {
        this.appliedThemes.set(file, previous);
        return previous.parsed;
      }
      return safe === null ? undefined : committed?.parsed;
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

  private async scanTheme(relative: string, tree: Map<string, TreeEntry>): Promise<void> {
    const kind = themeKind(relative);
    if (!kind) return;
    const entry = tree.get(relative);
    let bytes: Buffer | null;
    try {
      bytes = await this.read(relative);
    } catch (error) {
      this.heldThemes.delete(relative);
      this.reject(relative, invalid(error), invalid(error));
      return;
    }
    const revert = this.revertSubjects.get(relative);
    if (bytes === null) {
      this.appliedThemes.delete(relative);
      this.heldThemes.delete(relative);
      if (kind === "theme") await settle(this.deps.themeBaseline.set(relative, null), undefined);
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
    let name: string;
    try {
      const parsed = parseThemeFile(decode(bytes), kind);
      await this.reviewThemeValue(relative, decode(bytes), parsed);
      if (this.heldThemes.has(relative)) return;
      name = parsed.kind === "theme" ? parsed.theme.name : parsed.name;
    } catch (error) {
      this.heldThemes.delete(relative);
      this.reject(relative, object, invalid(error));
      return;
    }
    this.rejected.delete(relative);
    this.revertSubjects.delete(relative);
    if (entry?.object === object) return;
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
        ...(await this.pluginPaths()),
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
      for (const entry of this.history) {
        if (this.commitWarnings.has(entry.commit)) continue;
        const warnings: ThemeDiagnostic[] = [];
        const files = entry.files.filter((file) => themeKind(file) === "theme");
        if (files.length) {
          const committed = await this.deps.git.tree(entry.commit);
          for (const file of files) {
            const object = committed.get(file)?.object;
            if (!object) continue;
            try {
              const parsed = parseThemeFile(decode(await this.deps.git.blob(object)), "theme");
              if (parsed.kind === "theme")
                warnings.push(...(parsed.warnings ?? []).map((warning) => ({ ...warning, file })));
            } catch {
              /* Agent-authored invalid history is not an applied warning. */
            }
          }
        }
        this.commitWarnings.set(entry.commit, warnings);
      }
      for (const commit of this.commitWarnings.keys())
        if (!this.history.some((entry) => entry.commit === commit))
          this.commitWarnings.delete(commit);
    } catch {
      this.uncommitted = null;
    }
  }

  private warningStatus(commit: string): Pick<ConfigChange, "warnings" | "reason"> {
    const warnings = this.commitWarnings.get(commit) ?? [];
    return warnings.length
      ? {
          warnings: warnings.length,
          reason: warnings.map((warning) => `${warning.path}: ${warning.reason}`).join(" · "),
        }
      : {};
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
      ...this.warningStatus(entry.commit),
    }));
    const pending = this.pending;
    const held = this.heldThemes.entries().next().value;
    const plugin = this.heldPlugins.entries().next().value;
    return {
      agentPlugins: [
        ...[...this.heldPlugins].map(([file, proposal]) => ({
          id: proposal.manifest.id,
          name: proposal.manifest.name,
          mark: proposal.manifest.badge,
          command: proposal.manifest.executables[0] ?? proposal.manifest.id,
          file,
          state: "pending" as const,
          decisionId: digest(file + proposal.text),
        })),
        ...[...this.rejected.keys()]
          .filter((file) => file.startsWith("agents/"))
          .map((file) => ({
            id: file.slice(7, -5),
            name: file.slice(7, -5),
            mark: "?",
            command: file.slice(7, -5),
            file,
            state: "rejected" as const,
            reason: this.events.find((event) => event.file === file && event.state === "rejected")
              ?.reason,
          })),
      ],
      folder: this.deps.root,
      available: this.available,
      uncommitted: this.uncommitted,
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
          : plugin
            ? {
                id: digest(plugin[0] + plugin[1].text),
                file: plugin[0],
                action: "add or change an agent plugin",
                detail: "Review its executable, arguments, bypass flags and hook mapping",
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
    if (this.pending) {
      this.record({
        summary: "Held change replaced in Settings",
        file: SETTINGS_FILE,
        state: "rejected",
        reason: "Replaced by a change in Settings",
      });
    }
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
  }

  /**
   * Allow applies the held change and commits it; keep restores the applied file. `id`
   * names the proposal the user saw, so a click never approves a later replacement.
   */
  decide(decision: unknown, id: unknown): Promise<ConfigStatus> {
    if (decision !== "allow" && decision !== "keep")
      return Promise.reject(new Error("Invalid decision"));
    return this.serial(async () => {
      if ([...this.heldPlugins].some(([file, proposal]) => digest(file + proposal.text) === id))
        return this.decidePlugin(decision, id);
      const pending = this.pending;
      if (!pending) {
        const held = this.heldThemes.entries().next().value;
        if (!held) return this.decidePlugin(decision, id);
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
      const tree = await settle(this.headTree(), new Map<string, TreeEntry>());
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
        await this.apply(pending.text, pending.values, tree);
      } else {
        const committed = await this.committed(SETTINGS_FILE);
        const restore =
          committed && committed.toString("utf8") === this.applied.text
            ? committed
            : Buffer.from(this.applied.text);
        await this.writeFile(SETTINGS_FILE, restore);
        this.pending = null;
        this.events = this.events.filter((event) => event.state !== "pending");
        this.record({
          summary: `Kept on: ${pending.weak.map((entry) => entry.detail).join(", ")}`,
          file: SETTINGS_FILE,
          state: "rejected",
          reason: "Declined in Settings",
        });
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
