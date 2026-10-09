import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { validateConfigJson } from "../shared/config-files";
import { SOUND_KINDS, validSoundFile } from "../shared/sounds";
import {
  matchesSoundHeader,
  soundSizeLimit,
  validSoundDuration,
  SOUND_FILE_LIMIT,
} from "../shared/sound-files";
import type { SoundKind } from "../shared/sound";
import type { ThemeDiagnostic } from "../shared/theme-file";
import { ThemeValidationError, validThemeFile } from "../shared/theme-validation";

import type { ConfigFolderKind as FolderKind } from "../shared/config";
const fail = (reason: ThemeDiagnostic["reason"]): never => {
  throw new ThemeValidationError("$", reason);
};
const soundKind = (kind: FolderKind): kind is SoundKind =>
  SOUND_KINDS.some((value) => value === kind);

/** Descriptor-bounded read. Refuse links and special files before opening, then recheck identity. */
async function read(path: string, max: number): Promise<Uint8Array> {
  const before = await lstat(path);
  if (!before.isFile()) fail("unsafe-file");
  const parent = await realpath(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev) fail("unsafe-file");
    if (info.size > max) fail("too-large");
    const bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const next = await file.read(bytes, count, bytes.length - count, count);
      if (!next.bytesRead) break;
      count += next.bytesRead;
    }
    const after = await lstat(path);
    if (
      count !== info.size ||
      after.ino !== info.ino ||
      after.dev !== info.dev ||
      !after.isFile() ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      (await realpath(dirname(path))) !== parent
    )
      fail("unsafe-file");
    return bytes.subarray(0, count);
  } finally {
    await file.close();
  }
}
async function validateFile(path: string, kind?: FolderKind): Promise<void> {
  if (kind && soundKind(kind)) {
    if (!validSoundFile(basename(path))) fail("unsafe-file");
    const bytes = await read(path, soundSizeLimit(kind));
    if (!matchesSoundHeader(path, bytes.subarray(0, 512))) fail("invalid-value");
    try {
      const { parseBuffer } = await import("music-metadata");
      const metadata = await parseBuffer(
        bytes,
        { path: basename(path), size: bytes.length },
        { duration: true, skipCovers: true },
      );
      if (!validSoundDuration(kind, metadata.format.duration ?? NaN)) fail("invalid-value");
    } catch {
      fail("invalid-value");
    }
  } else {
    const bytes = await read(path, 65536);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return fail("malformed-json");
    }
    validateConfigJson(
      text,
      kind === "settings" || kind === "theme" || kind === "terminal-theme" ? kind : undefined,
    );
  }
}
/** Offline, read-only: only the explicitly supplied file/tree is ever inspected. */
export async function validateConfig(
  path: string,
): Promise<{ problems: ThemeDiagnostic[]; code: number }> {
  const problems: ThemeDiagnostic[] = [];
  const status = { ioError: false };
  const report = (file: string, error: unknown) => {
    if (!(error instanceof ThemeValidationError)) status.ioError = true;
    problems.push({
      file,
      path: error instanceof ThemeValidationError ? error.path : "$",
      reason: error instanceof ThemeValidationError ? error.reason : "unreadable",
    });
  };
  const visitFile = async (file: string, label: string, kind?: FolderKind) => {
    try {
      await validateFile(file, kind);
    } catch (error) {
      report(label, error);
    }
  };
  const folder = async (directory: string, label: string, kind: FolderKind) => {
    try {
      const before = await lstat(directory);
      if (!before.isDirectory()) fail("unsafe-file");
      const canonical = await realpath(directory);
      const entries = await opendir(directory);
      let count = 0;
      const limit = soundKind(kind)
        ? SOUND_FILE_LIMIT
        : kind === "config"
          ? 4
          : kind === "sounds"
            ? 4
            : 50;
      for await (const entry of entries) {
        if (++count > limit) {
          report(label, new ThemeValidationError("$", "too-many-files"));
          break;
        }
        const current = await lstat(directory);
        if (
          !current.isDirectory() ||
          current.ino !== before.ino ||
          current.dev !== before.dev ||
          (await realpath(directory)) !== canonical
        )
          fail("unsafe-file");
        const file = join(directory, entry.name);
        const name = label ? `${label}/${entry.name}` : entry.name;
        let child: FolderKind | undefined;
        if (kind === "config") {
          if (entry.name === "settings.json") {
            await visitFile(file, name, "settings");
            continue;
          }
          if (entry.name === "themes") child = "theme";
          if (entry.name === "terminal-themes") child = "terminal-theme";
          if (entry.name === "sounds") child = "sounds";
        } else if (kind === "sounds") child = SOUND_KINDS.find((value) => value === entry.name);
        else {
          if (!(soundKind(kind) ? validSoundFile(entry.name) : validThemeFile(entry.name)))
            report(name, new ThemeValidationError("$", "unsafe-file"));
          else await visitFile(file, name, kind);
          continue;
        }
        if (child) await folder(file, name, child);
        else report(name, new ThemeValidationError("$", "unsafe-file"));
      }
    } catch (error) {
      report(label, error);
    }
  };
  const absolute = resolve(path);
  try {
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      const name = basename(absolute);
      const kind =
        name === "themes"
          ? "theme"
          : name === "terminal-themes"
            ? "terminal-theme"
            : name === "sounds"
              ? "sounds"
              : (SOUND_KINDS.find((value) => value === name) ?? "config");
      await folder(absolute, "", kind);
    } else {
      const kind = SOUND_KINDS.find((value) => value === basename(dirname(absolute)));
      await visitFile(absolute, basename(absolute), kind);
    }
  } catch (error) {
    report(basename(absolute), error);
  }
  problems.sort((a, b) => a.file.localeCompare(b.file) || a.path.localeCompare(b.path));
  return { problems, code: status.ioError ? 2 : problems.length ? 1 : 0 };
}
