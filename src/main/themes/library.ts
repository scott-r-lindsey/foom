import { constants, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ParsedThemeFile,
  ThemeCatalog,
  ThemeDiagnostic,
  ThemeKind,
} from "../../shared/theme-file";
import { parseThemeFile } from "../../shared/theme-files";
import { ThemeValidationError, validThemeFile } from "../../shared/theme-validation";
import { interfaceThemes } from "../../shared/interface-themes";
import { terminalThemeOptions } from "../../shared/terminal-themes";
const kinds = ["theme", "terminal-theme"] as const;
/** Owns bounded reads and session-only last-good versions. No raw contents escape main. */
export class ThemeLibrary {
  private catalog: ThemeCatalog = { interface: [], terminal: [], errors: [] };
  private good = new Map<string, ParsedThemeFile>();
  private queue: Promise<void> = Promise.resolve();
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(
    private readonly root: string,
    private readonly changed: () => void = () => {},
  ) {}
  folder(kind: ThemeKind): string {
    return join(this.root, kind === "theme" ? "themes" : "terminal-themes");
  }
  snapshot(): ThemeCatalog {
    return structuredClone(this.catalog);
  }
  async initialize(): Promise<void> {
    for (const kind of kinds) {
      try {
        await mkdir(this.folder(kind), { recursive: true, mode: 0o700 });
      } catch {
        /* Reload reports unavailable folders. */
      }
    }
    this.startWatching();
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
      const next: {
        interface: ThemeCatalog["interface"][number][];
        terminal: ThemeCatalog["terminal"][number][];
        errors: ThemeCatalog["errors"][number][];
      } = { interface: [], terminal: [], errors: [] };
      const retained = new Map<string, ParsedThemeFile>();
      for (const kind of kinds) {
        let names: string[];
        const nonFiles = new Set<string>();
        try {
          if (!(await lstat(this.folder(kind))).isDirectory()) throw new Error("unsafe directory");
          const entries = await readdir(this.folder(kind), { withFileTypes: true });
          for (const entry of entries)
            if (!entry.isFile() && !entry.isSymbolicLink()) nonFiles.add(entry.name);
          names = entries
            .map((entry) => entry.name)
            .sort(
              (a, b) =>
                Number(this.good.has(`${kind}/${b}`)) - Number(this.good.has(`${kind}/${a}`)) ||
                a.localeCompare(b),
            );
        } catch {
          next.errors.push({ kind, file: "(folder)", path: "$", reason: "unreadable" });
          // An inaccessible directory is not evidence that its files were deleted.
          names = [...this.good.keys()]
            .filter((key) => key.startsWith(`${kind}/`))
            .map((key) => key.slice(kind.length + 1));
        }
        let count = 0;
        for (const file of names) {
          const key = `${kind}/${file}`;
          let theme: ParsedThemeFile | undefined;
          let diagnostic: ThemeDiagnostic | undefined;
          if (!validThemeFile(file) || nonFiles.has(file)) {
            // Retained versions still occupy a slot even when their file became a directory.
            if (this.good.has(key)) count++;
            diagnostic = { file, path: "$", reason: "unsafe-file" };
          } else if (++count > 50) diagnostic = { file, path: "$", reason: "too-many-files" };
          else {
            try {
              theme = await this.read(kind, file);
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
            if (next.errors.filter((error) => error.kind === kind).length < 100)
              next.errors.push({
                ...diagnostic,
                file: file.replace(/[\p{Cc}\p{Cf}]/gu, "�").slice(0, 100),
                kind,
              });
            theme = this.good.get(key);
          }
          if (!theme) continue;
          retained.set(key, theme);
          if (theme.kind === "theme") {
            const collision = Object.values(interfaceThemes).some(
              (builtin) => builtin.name.toLowerCase() === theme.theme.name.toLowerCase(),
            );
            next.interface.push({
              id: `user:${file}`,
              theme: { ...theme.theme, name: theme.theme.name + (collision ? " (custom)" : "") },
            });
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
      this.startWatching();
      if (changed) this.changed();
    });
    return this.queue;
  }
  private async read(kind: ThemeKind, name: string): Promise<ParsedThemeFile> {
    const directory = this.folder(kind);
    if (!(await lstat(directory)).isDirectory()) throw new ThemeValidationError("$", "unsafe-file");
    const root = await realpath(directory);
    const target = await realpath(join(root, name));
    if (dirname(target) !== root) throw new ThemeValidationError("$", "unsafe-file");
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new ThemeValidationError("$", "unsafe-file");
      if (info.size > 65536) throw new ThemeValidationError("$", "too-large");
      const bytes = Buffer.alloc(65537);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > 65536) throw new ThemeValidationError("$", "too-large");
      const current = await lstat(target);
      if (
        !(await lstat(directory)).isDirectory() ||
        (await realpath(directory)) !== root ||
        (await realpath(join(root, name))) !== target ||
        !current.isFile() ||
        current.ino !== info.ino ||
        current.dev !== info.dev ||
        current.size !== size ||
        current.mtimeMs !== info.mtimeMs
      )
        throw new ThemeValidationError("$", "unsafe-file");
      return parseThemeFile(bytes.subarray(0, size).toString("utf8"), kind);
    } finally {
      await handle.close();
    }
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
}
