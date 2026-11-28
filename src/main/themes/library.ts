import { createHash } from "node:crypto";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ParsedThemeFile,
  ThemeCatalog,
  ThemeDiagnostic,
  ThemeKind,
  ThemeSnapshot,
  UserThemeId,
} from "../../shared/theme-file";
import { parseThemeFile } from "../../shared/theme-files";
import { ThemeValidationError, validThemeFile } from "../../shared/theme-validation";
import { interfaceThemes } from "../../shared/interface-themes";
import { terminalThemeOptions } from "../../shared/terminal-themes";
import { themeFolderLimit, validThemeBitmapFile } from "../../shared/theme-bitmaps";
import type { ActiveThemeBitmaps } from "../../shared/theme-bitmap";
import { readThemeDirectory } from "../theme-directory";
import { readThemeFile } from "./files";
export { ThemeBitmaps, themeBitmapResponse } from "./bitmaps";

const kinds = ["theme", "terminal-theme"] as const;
const diagnosticLimit = 100;
function catalogTheme(theme: ThemeCatalog["interface"][number]["theme"]) {
  const collision = Object.values(interfaceThemes).some(
    (builtin) => builtin.name.toLowerCase() === theme.name.toLowerCase(),
  );
  return { ...theme, name: theme.name + (collision ? " (custom)" : "") };
}
/** Owns bounded reads and session-only last-good versions. No raw contents escape main. */
export class ThemeLibrary {
  private catalog: ThemeCatalog = { interface: [], terminal: [], errors: [] };
  private good = new Map<string, ThemeSnapshot>();
  private queue: Promise<void> = Promise.resolve();
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(
    private readonly root: string,
    private readonly changed: () => void = () => {},
    private readonly review?: (
      file: string,
      text: string,
      theme: ParsedThemeFile,
    ) => Promise<ThemeSnapshot | undefined>,
    private readonly activePalette?: () =>
      | {
          id: UserThemeId;
          digest?: string;
          bitmaps?: ActiveThemeBitmaps["slots"];
          warnings: readonly ThemeDiagnostic[];
          theme: ThemeCatalog["interface"][number]["theme"] | undefined;
        }
      | undefined,
  ) {}
  folder(kind: ThemeKind): string {
    return join(this.root, kind === "theme" ? "themes" : "terminal-themes");
  }
  snapshot(): ThemeCatalog {
    const active = this.activePalette?.();
    if (!active) return structuredClone(this.catalog);
    // The independent catalog reload may still have an older inactive palette.
    // Always substitute the snapshot approved for the active selection.
    const entries = [...this.catalog.interface];
    const index = entries.findIndex(({ id }) => id === active.id);
    if (active.theme) {
      const entry = {
        id: active.id,
        theme: catalogTheme(active.theme),
        ...(active.digest && { digest: active.digest }),
      };
      if (index === -1) entries.push(entry);
      else entries[index] = entry;
    } else if (index !== -1) entries.splice(index, 1);
    const file = active.id.slice("user:".length);
    const warnings = active.warnings
      .slice(0, diagnosticLimit)
      .map((warning) => ({ ...warning, kind: "theme" as const, file }));
    const interfaceErrors = this.catalog.errors
      .filter(
        (entry) => entry.kind === "theme" && !(entry.file === file && entry.severity === "warning"),
      )
      .slice(0, diagnosticLimit - warnings.length);
    const terminalErrors = this.catalog.errors.filter((entry) => entry.kind === "terminal-theme");
    return structuredClone({
      ...this.catalog,
      interface: entries,
      errors: [...warnings, ...interfaceErrors, ...terminalErrors],
      ...(active.bitmaps && { activeBitmaps: { theme: active.id, slots: active.bitmaps } }),
    });
  }
  async initialize(): Promise<void> {
    for (const kind of kinds) {
      try {
        await mkdir(this.folder(kind), { recursive: true, mode: 0o700 });
      } catch {
        /* Reload reports unavailable folders. */
      }
    }
    await this.reload();
  }
  private startWatching(): void {
    if (this.isDisposed()) return;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    // Watching the parent also catches replacement/removal of a theme folder.
    for (const directory of [this.root, ...kinds.map((kind) => this.folder(kind))]) {
      try {
        const watcher = watch(directory, () => {
          this.schedule();
        });
        watcher.on("error", () => {
          watcher.close();
          this.schedule();
        });
        this.watchers.push(watcher);
      } catch {
        /* A later parent event or list request retries subscriptions. */
      }
    }
  }
  private isDisposed(): boolean {
    return this.disposed;
  }
  private schedule(): void {
    if (this.isDisposed()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.reload();
    }, 250);
  }
  reload(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.isDisposed()) return;
      // Reconnect before reading: closing a watcher after the read can discard
      // an edit's queued notification and leave the published palette stale.
      this.startWatching();
      const next: {
        interface: ThemeCatalog["interface"][number][];
        terminal: ThemeCatalog["terminal"][number][];
        errors: ThemeCatalog["errors"][number][];
      } = { interface: [], terminal: [], errors: [] };
      const retained = new Map<string, ThemeSnapshot>();
      for (const kind of kinds) {
        let names: string[];
        const regular = new Set<string>();
        const aliases = new Set<string>();
        try {
          const entries = await readThemeDirectory(this.folder(kind));
          for (const entry of entries) {
            if (entry.isFile()) regular.add(entry.name);
            else if (entry.isSymbolicLink()) aliases.add(entry.name);
          }
          names = entries
            .map((entry) => entry.name)
            .sort(
              (a, b) =>
                Number(regular.has(b)) - Number(regular.has(a)) ||
                Number(this.good.has(`${kind}/${b}`)) - Number(this.good.has(`${kind}/${a}`)) ||
                a.localeCompare(b),
            );
        } catch (error) {
          const reason = error instanceof ThemeValidationError ? error.reason : "unreadable";
          next.errors.push({ kind, file: "(folder)", path: "$", reason });
          // An inaccessible directory is not evidence that its files were deleted.
          names = [...this.good.keys()]
            .filter((key) => key.startsWith(`${kind}/`))
            .map((key) => key.slice(kind.length + 1));
          for (const file of names) regular.add(file);
        }
        let count = kind === "theme" ? [...regular].filter(validThemeBitmapFile).length : 0;
        // A last-good palette still occupies registry space after an unsafe
        // replacement. This reservation is separate from the regular-file budget.
        let admitted =
          count +
          names.filter((file) => !regular.has(file) && this.good.has(`${kind}/${file}`)).length;
        for (const file of names) {
          const key = `${kind}/${file}`;
          // Bitmap diagnostics belong to fixed slots on their JSON theme. Do
          // not publish names of artwork or any other non-theme files here.
          if (kind === "theme" && !file.endsWith(".json")) continue;
          let snapshot: ThemeSnapshot | undefined;
          let diagnostic: ThemeDiagnostic | undefined;
          const isRegular = regular.has(file);
          if (!validThemeFile(file) || (!isRegular && !aliases.has(file))) {
            diagnostic = { file, path: "$", reason: "unsafe-file" };
          } else if (
            (isRegular && ++count > themeFolderLimit) ||
            ((isRegular || !this.good.has(key)) && admitted >= themeFolderLimit)
          )
            diagnostic = { file, path: "$", reason: "too-many-files" };
          else {
            try {
              snapshot = await this.read(kind, file);
            } catch (error) {
              diagnostic = {
                file,
                path: error instanceof ThemeValidationError ? error.path : "$",
                reason: error instanceof ThemeValidationError ? error.reason : "unreadable",
              };
            }
          }
          if (diagnostic) {
            // Diagnostic text is bounded too, even for enormous directories or unsafe names.
            if (next.errors.filter((error) => error.kind === kind).length < diagnosticLimit)
              next.errors.push({
                ...diagnostic,
                file: file.replace(/[\p{Cc}\p{Cf}]/gu, "�").slice(0, 100),
                kind,
              });
            snapshot = this.good.get(key);
          }
          if (!snapshot) continue;
          if (isRegular || !this.good.has(key)) admitted++;
          retained.set(key, snapshot);
          const { parsed: theme, digest } = snapshot;
          if (theme.kind === "theme")
            next.errors.push(
              ...[...(theme.warnings ?? []), ...(snapshot.imageDiagnostics ?? [])]
                .slice(
                  0,
                  Math.max(
                    0,
                    diagnosticLimit - next.errors.filter((error) => error.kind === kind).length,
                  ),
                )
                .map((warning) => ({ ...warning, file, kind })),
            );
          if (theme.kind === "theme") {
            next.interface.push({ id: `user:${file}`, theme: catalogTheme(theme.theme), digest });
          } else {
            const collision = terminalThemeOptions.some(
              (builtin) => builtin.name.toLowerCase() === theme.name.toLowerCase(),
            );
            next.terminal.push({
              id: `user:${file}`,
              name: theme.name + (collision ? " (custom)" : ""),
              theme: theme.theme,
            });
          }
        }
      }
      if (this.isDisposed()) return;
      const changed = JSON.stringify(next) !== JSON.stringify(this.catalog);
      this.catalog = next;
      this.good = retained;
      if (changed) this.changed();
    });
    return this.queue;
  }
  private async read(kind: ThemeKind, name: string): Promise<ThemeSnapshot | undefined> {
    const text = (await readThemeFile(this.folder(kind), name, 65536, true)).toString("utf8");
    // Review joins the config service's queue, which may already contain a restore.
    // Never retain the target descriptor while waiting for that writer.
    const parsed = parseThemeFile(text, kind);
    return this.review
      ? this.review(`${kind === "theme" ? "themes" : "terminal-themes"}/${name}`, text, parsed)
      : { parsed, digest: createHash("sha256").update(text).digest("hex") };
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}
