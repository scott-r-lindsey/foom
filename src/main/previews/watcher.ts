import fs from "node:fs";
import path from "node:path";
import { inside } from "./policy";

/** Watches directory entries, so rename-over saves do not invalidate a watch. */
export class PreviewWatcher {
  private readonly directories = new Map<string, { names: Set<string>; watch: fs.FSWatcher }>();
  private trailing: ReturnType<typeof setTimeout> | undefined;
  private maximum: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  constructor(
    private readonly root: string,
    private readonly changed: () => void,
  ) {}
  get count(): number {
    return this.directories.size;
  }
  record(file: string): void {
    if (this.closed || !inside(this.root, file, path.sep)) return;
    let directory = path.dirname(file);
    let name = path.basename(file);
    // Missing nested directories: watch the nearest existing contained ancestor.
    let real: string;
    for (;;) {
      try {
        real = fs.realpathSync.native(directory);
        break;
      } catch {
        if (directory === this.root) return;
        name = path.basename(directory);
        directory = path.dirname(directory);
      }
    }
    if (real !== this.root && !inside(this.root, real, path.sep)) return;
    // Also observe a symlink/junction in the requested parent path.
    if (real !== directory) this.record(directory);
    const existing = this.directories.get(real);
    if (existing) {
      existing.names.add(name);
      return;
    }
    if (this.count >= 64) return;
    try {
      const names = new Set([name]);
      const watch = fs.watch(real, { recursive: false }, (_event, filename) => {
        if (filename === null || names.has(filename)) this.schedule();
      });
      this.directories.set(real, { names, watch });
      watch.on("error", () => {
        watch.close();
        this.directories.delete(real);
        this.schedule();
      });
    } catch {
      // A directory can disappear between resolution and subscription.
    }
  }
  private schedule(): void {
    if (this.closed) return;
    clearTimeout(this.trailing);
    this.trailing = setTimeout(this.flush, 120);
    this.maximum ??= setTimeout(this.flush, 1000);
  }
  private readonly flush = () => {
    clearTimeout(this.trailing);
    clearTimeout(this.maximum);
    this.trailing = undefined;
    this.maximum = undefined;
    this.changed();
  };
  close(): void {
    this.closed = true;
    clearTimeout(this.trailing);
    clearTimeout(this.maximum);
    for (const { watch } of this.directories.values()) watch.close();
    this.directories.clear();
  }
}

export function scrollPosition(value: unknown): [number, number] | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every(
      (coordinate: unknown) =>
        typeof coordinate === "number" &&
        Number.isFinite(coordinate) &&
        Math.abs(coordinate) <= 1e9,
    )
  )
    return undefined;
  const coordinates: unknown[] = value;
  const x = coordinates[0];
  const y = coordinates[1];
  if (typeof x !== "number" || typeof y !== "number") return undefined;
  return [x, y];
}
