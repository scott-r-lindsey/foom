import fs from "node:fs";
import { walkPreviewPath } from "./contained-files";

/** Watches directory entries, so rename-over saves do not invalidate a watch. */
export class PreviewWatcher {
  private readonly directories = new Map<string, { names: Set<string>; watch: fs.FSWatcher }>();
  private trailing: ReturnType<typeof setTimeout> | undefined;
  private maximum: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private generation = 0;
  constructor(
    private readonly root: string,
    private readonly changed: () => void,
  ) {}
  get count(): number {
    return this.directories.size;
  }
  /** Drop the previous load's dependencies and pending notifications. */
  beginGeneration(): void {
    this.generation++;
    clearTimeout(this.trailing);
    clearTimeout(this.maximum);
    this.trailing = undefined;
    this.maximum = undefined;
    for (const { watch } of this.directories.values()) watch.close();
    this.directories.clear();
  }
  /** Bind asynchronous resource observations to the load that requested them. */
  recorder(): (file: string) => Promise<void> {
    const generation = this.generation;
    return async (file) => {
      if (this.generation === generation) await this.record(file);
    };
  }
  async record(file: string): Promise<void> {
    if (this.closed) return;
    const generation = this.generation;
    const route = await walkPreviewPath(this.root, file);
    if (this.generation !== generation || "status" in route) return;
    for (const { directory, name } of route.watches) this.subscribe(directory, name);
  }
  private subscribe(directory: string, name: string): void {
    const existing = this.directories.get(directory);
    if (existing) {
      existing.names.add(name);
      return;
    }
    if (this.count >= 64) return;
    try {
      if (fs.realpathSync.native(directory) !== directory) return;
      const names = new Set([name]);
      const watch = fs.watch(directory, { recursive: false }, (_event, filename) => {
        if (this.directories.get(directory)?.names !== names) return;
        if (filename === null || names.has(filename)) this.schedule();
      });
      this.directories.set(directory, { names, watch });
      watch.on("error", () => {
        if (this.directories.get(directory)?.names !== names) return;
        watch.close();
        this.directories.delete(directory);
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
    this.beginGeneration();
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
