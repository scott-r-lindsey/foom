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
  maxTimer?: ReturnType<typeof setTimeout>;
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
    clearTimeout(entry.maxTimer);
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
      // Release deleted-directory handles before discovery: Windows can keep
      // reporting rename events for them until they are closed.
      for (const handle of entry.handles) handle.close();
      entry.handles = [];
      const paths = await this.paths(path);
      if (!current()) return;
      let rebuild = false;
      const flush = () => {
        clearTimeout(entry.timer);
        clearTimeout(entry.maxTimer);
        delete entry.timer;
        delete entry.maxTimer;
        const publish = () => {
          if (!this.closed && this.entries.get(path) === entry && !entry.failed) this.changed();
        };
        // Rebuild first so changes during discovery are included in the refresh.
        if (rebuild) void this.arm(path, entry).then(publish);
        else publish();
      };
      const schedule = (discover: boolean) => {
        if (!current() || entry.failed) return;
        rebuild ||= discover;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(flush, 300);
        // A deleted directory can produce a continuous Windows rename stream.
        // Never let incoming events postpone refresh indefinitely.
        entry.maxTimer ??= setTimeout(flush, 1000);
      };
      for (const target of paths) {
        const handle = this.watchPath(target, () => {
          schedule(true);
        });
        entry.handles.push(handle);
        handle.on("error", () => {
          if (!current() || !entry.handles.includes(handle)) return;
          // Windows reports EPERM when a watched directory is deleted. Retain
          // parent/sibling watches and any pending rebuild; an error alone only
          // refreshes inventory, so persistent failures cannot cause retry loops.
          handle.close();
          entry.handles = entry.handles.filter((candidate) => candidate !== handle);
          schedule(false);
        });
      }
    } catch (error) {
      console.error("Unable to watch Git inventory; window focus will refresh it:", error);
      fail();
    }
  }

  dispose(): void {
    this.closed = true;
    for (const entry of this.entries.values()) this.close(entry);
    this.entries.clear();
  }
}
