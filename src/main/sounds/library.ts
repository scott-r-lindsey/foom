import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { SoundEntry, SoundKind, SoundRead, SoundRequest } from "../../shared/sound";
import { parseSoundRequest, SOUND_KINDS, soundName, validSoundFile } from "../../shared/sounds";

export function soundSizeLimit(kind: SoundKind): number {
  return (kind === "working" ? 8 : 2) * 1024 * 1024;
}
export function matchesSoundHeader(file: string, bytes: Buffer): boolean {
  const starts = (text: string, at = 0) => bytes.toString("ascii", at, at + text.length) === text;
  switch (extname(file).toLowerCase()) {
    case ".wav":
      return starts("RIFF") && starts("WAVE", 8);
    case ".flac":
      return starts("fLaC");
    case ".ogg":
      return (
        starts("OggS") &&
        (bytes.includes(Buffer.from("OpusHead")) || bytes.includes(Buffer.from("\x01vorbis")))
      );
    case ".opus":
      return starts("OggS") && bytes.includes(Buffer.from("OpusHead"));
    case ".mp3":
      return (
        (starts("ID3") && [2, 3, 4].includes(bytes[3] ?? 0)) ||
        (bytes[0] === 0xff &&
          ((bytes[1] ?? 0) & 0xe6) === 0xe2 &&
          ((bytes[2] ?? 0) & 0xf0) !== 0xf0)
      );
    default:
      return false;
  }
}
/** All paths stay in main. Bounded reads use the inspected open descriptor, not a second open. */
export class SoundLibrary {
  constructor(
    private readonly builtin: string,
    readonly user: string,
  ) {}
  async initialize(): Promise<void> {
    for (const kind of SOUND_KINDS)
      await mkdir(join(this.user, kind), { recursive: true, mode: 0o700 });
  }
  private async inspect(request: SoundRequest, full: boolean): Promise<SoundRead> {
    try {
      const directory = join(request.source === "builtin" ? this.builtin : this.user, request.kind);
      // The kind folders themselves cannot redirect the capability elsewhere.
      if (!(await lstat(directory)).isDirectory())
        return { error: "Sound folder is not a regular directory" };
      const root = await realpath(directory);
      const target = await realpath(join(root, request.file));
      if (dirname(target) !== root)
        return { error: "Sound links must stay inside their kind folder" };
      if (request.source === "builtin") {
        // Electron supports readFile/readdir for immutable ASAR entries, not descriptor reads.
        const info = await lstat(target);
        if (!info.isFile() || info.size > soundSizeLimit(request.kind))
          return { error: "Invalid bundled sound" };
        const bytes = await readFile(target);
        if (bytes.length > soundSizeLimit(request.kind) || !matchesSoundHeader(request.file, bytes))
          return { error: "Invalid bundled sound" };
        return { bytes: new Uint8Array(bytes) };
      }
      const file = await open(
        target,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      try {
        const info = await file.stat();
        if (!info.isFile()) return { error: "Sound must be a regular file" };
        const max = soundSizeLimit(request.kind);
        if (info.size > max)
          return { error: `Sound exceeds the ${request.kind === "working" ? "8" : "2"} MB limit` };
        const buffer = Buffer.alloc(full ? info.size + 1 : Math.min(info.size, 512));
        let count = 0;
        while (count < buffer.length) {
          const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
          if (!bytesRead) break;
          count += bytesRead;
        }
        if (full && count > info.size) return { error: "Sound changed while being read" };
        // Recheck the name and directory after opening, including in-folder link retargeting.
        if (
          (await realpath(directory)) !== root ||
          (await realpath(join(root, request.file))) !== target
        )
          return { error: "Sound changed while being read" };
        const current = await lstat(target);
        if (current.ino !== info.ino || current.dev !== info.dev || !current.isFile())
          return { error: "Sound changed while being read" };
        const bytes = buffer.subarray(0, count);
        if (!matchesSoundHeader(request.file, bytes))
          return { error: "Audio header does not match its extension" };
        return { bytes: new Uint8Array(bytes) };
      } finally {
        await file.close();
      }
    } catch {
      return { error: "Sound is missing or unreadable" };
    }
  }
  async read(value: unknown): Promise<SoundRead> {
    const request = parseSoundRequest(value);
    // The same 100-file catalog bounds both listing and direct reads.
    const names = await this.names(request.source, request.kind);
    if (!names.includes(request.file))
      return { error: "Sound is missing or outside the 100-file limit" };
    return this.inspect(request, true);
  }
  private async names(source: "builtin" | "user", kind: SoundKind): Promise<string[]> {
    const result: string[] = [];
    try {
      const directory = join(source === "builtin" ? this.builtin : this.user, kind);
      if (!(await lstat(directory)).isDirectory()) return result;
      const entries =
        source === "builtin"
          ? await readdir(directory, { withFileTypes: true })
          : await opendir(directory);
      for await (const entry of entries) {
        if (validSoundFile(entry.name) && (entry.isFile() || entry.isSymbolicLink()))
          result.push(entry.name);
        if (result.length === 100) break;
      }
    } catch {
      /* An unavailable folder is an empty catalog; selected files still explain fallback. */
    }
    return result.sort();
  }
  async list(): Promise<SoundEntry[]> {
    await this.initialize();
    const entries: SoundEntry[] = [];
    for (const kind of SOUND_KINDS)
      for (const source of ["builtin", "user"] as const) {
        for (const file of await this.names(source, kind)) {
          const request = { kind, source, file };
          const result = await this.inspect(request, false);
          entries.push({
            ...request,
            name: soundName(file),
            ...("error" in result ? { error: result.error } : {}),
          });
        }
      }
    return entries;
  }
}
