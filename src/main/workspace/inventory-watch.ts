import { watch } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** Watch directories, not file inodes: Git replaces HEAD and packed-refs by rename. */
export async function inventoryWatchPaths(common: string): Promise<string[]> {
  if (!isAbsolute(common) || resolve(common) !== common || common.includes("\0"))
    throw new Error("Invalid Git common directory");
  if ((await realpath(common)) !== common) throw new Error("Git directory was redirected");
  const paths = [common];
  const descend = async (path: string, recursive: boolean): Promise<void> => {
    const stat = await lstat(path).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (!stat.isDirectory() || (await realpath(path)) !== path)
      throw new Error("Invalid Git metadata directory");
    paths.push(path);
    if (recursive)
      for (const entry of await readdir(path, { withFileTypes: true }))
        if (entry.isDirectory()) await descend(join(path, entry.name), true);
  };
  // Parents detect newly created subdirectories, even with all branches packed.
  await descend(join(common, "refs"), false);
  await descend(join(common, "refs", "heads"), true);
  await descend(join(common, "worktrees"), true);
  return paths;
}

type WatchHandle = { close(): void; on(event: "error", callback: () => void): unknown };
type Entry = {
  handles: WatchHandle[];
  timer?: ReturnType<typeof setTimeout>;
  revision: number;
  failed: boolean;
};

/** Best-effort notifications only; commands still validate fresh Git inventory. */
export class InventoryWatch {
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  constructor(
    private readonly paths: (repository: string) => Promise<readonly string[]>,
    private readonly changed: () => void,
    private readonly watchPath: (path: string, changed: () => void) => WatchHandle = (
      path,
      changed,
    ) => watch(path, { persistent: false }, changed),
  ) {}

  sync(repositories: readonly { path: string }[]): void {
    if (this.closed) return;
    const next = new Set(repositories.map((repository) => repository.path));
    for (const [path, entry] of this.entries) {
      if (next.has(path)) continue;
      this.close(entry);
      this.entries.delete(path);
    }
    for (const path of next) {
      if (this.entries.has(path)) continue;
      const entry: Entry = { handles: [], revision: 0, failed: false };
      this.entries.set(path, entry);
      void this.arm(path, entry);
    }
  }

  private close(entry: Entry): void {
    entry.revision++;
    clearTimeout(entry.timer);
    for (const handle of entry.handles) handle.close();
    entry.handles = [];
  }

  private async arm(path: string, entry: Entry): Promise<void> {
    const revision = ++entry.revision;
    const current = () =>
      !this.closed && this.entries.get(path) === entry && entry.revision === revision;
    const fail = () => {
      if (!current()) return;
      this.close(entry);
      entry.failed = true;
      // Focus refresh remains available, without retry loops on unsupported filesystems.
      this.changed();
    };
    try {
      const paths = await this.paths(path);
      if (!current()) return;
      for (const handle of entry.handles) handle.close();
      entry.handles = [];
      for (const target of paths) {
        const handle = this.watchPath(target, () => {
          if (!current() || entry.failed) return;
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => {
            // Rebuild first, then refresh: changes during async discovery must
            // be reflected even while the previous subscriptions are superseded.
            void this.arm(path, entry).then(() => {
              if (!this.closed && this.entries.get(path) === entry && !entry.failed) this.changed();
            });
          }, 300);
        });
        entry.handles.push(handle);
        handle.on("error", fail);
      }
    } catch {
      fail();
    }
  }

  dispose(): void {
    this.closed = true;
    for (const entry of this.entries.values()) this.close(entry);
    this.entries.clear();
  }
}
