import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PreviewRecord } from "../../shared/previews";
import { segmentsFor } from "./policy";

export function previewId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}
export function previewPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("/") &&
    /\.(md|markdown|html|htm)$/i.test(value) &&
    !("error" in segmentsFor(`/${value.split("/").map(encodeURIComponent).join("/")}`))
  );
}
export function parseRegistry(value: unknown): PreviewRecord[] {
  if (!Array.isArray(value) || value.length > 256) return [];
  const ids = new Set<string>();
  return value.flatMap((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Object.keys(entry).length !== 4 ||
      !("id" in entry) ||
      !previewId(entry.id) ||
      ids.has(entry.id) ||
      !("worktree" in entry) ||
      typeof entry.worktree !== "string" ||
      !entry.worktree ||
      entry.worktree.length > 4096 ||
      entry.worktree.includes("\0") ||
      !("relativePath" in entry) ||
      !previewPath(entry.relativePath) ||
      !("network" in entry) ||
      entry.network !== false
    )
      return [];
    ids.add(entry.id);
    return [
      {
        id: entry.id,
        worktree: entry.worktree,
        relativePath: entry.relativePath,
        network: false as const,
      },
    ];
  });
}

/** Paths stay in the profile, never in the board's localStorage. Writes are serialized. */
export class PreviewRegistry {
  readonly records = new Map<string, PreviewRecord>();
  private saving = Promise.resolve();
  constructor(private readonly file: string) {}
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, "utf8");
      if (raw.length <= 1024 * 1024)
        for (const entry of parseRegistry(JSON.parse(raw))) this.records.set(entry.id, entry);
    } catch {
      /* A missing or malformed registry restores no capabilities. */
    }
  }
  add(worktree: string, relativePath: string, id?: string): PreviewRecord {
    if (this.records.size >= 256) throw new Error("Preview capacity reached");
    const record: PreviewRecord = {
      id: id ?? randomBytes(16).toString("hex"),
      worktree,
      relativePath,
      network: false,
    };
    this.records.set(record.id, record);
    return record;
  }
  save(): Promise<void> {
    const text = JSON.stringify(
      [...this.records.values()]
        .filter((record) => !record.bundled)
        .map(({ agentOpened: _agentOpened, openedBy: _openedBy, ...record }) => ({
          ...record,
          network: false,
        })),
    );
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.${randomBytes(16).toString("hex")}.tmp`;
        try {
          await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
          await rename(temporary, this.file);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    return this.saving;
  }
}
