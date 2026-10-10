import type { ConfigDirectory } from "./types";
import { soundDuration } from "./sound-duration";
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
/** Foom-owned entries in the config root: its repository, docs and schemas. */
const FOOM_OWNED = [".git", ".gitignore", "README.md", "AGENTS.md", "CLAUDE.md", "schemas"];
const fail = (reason: ThemeDiagnostic["reason"]): never => {
  throw new ThemeValidationError("$", reason);
};
const soundKind = (kind: FolderKind): kind is SoundKind =>
  SOUND_KINDS.some((value) => value === kind);

async function directoryIdentity(path: string): Promise<ConfigDirectory> {
  const info = await lstat(path);
  if (!info.isDirectory()) fail("unsafe-file");
  const identity = { path, canonical: await realpath(path), ino: info.ino, dev: info.dev };
  await checkDirectory(identity);
  return identity;
}
async function checkDirectory(identity: ConfigDirectory): Promise<void> {
  const current = await lstat(identity.path);
  if (
    !current.isDirectory() ||
    current.ino !== identity.ino ||
    current.dev !== identity.dev ||
    (await realpath(identity.path)) !== identity.canonical
  )
    fail("unsafe-file");
}
/** Descriptor-bounded read. Refuse links and special files before opening, then recheck identity. */
async function read(path: string, max: number, parent: ConfigDirectory): Promise<Uint8Array> {
  await checkDirectory(parent);
  const before = await lstat(path);
  if (!before.isFile()) fail("unsafe-file");
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    await checkDirectory(parent);
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
      after.mtimeMs !== info.mtimeMs
    )
      fail("unsafe-file");
    await checkDirectory(parent);
    return bytes.subarray(0, count);
  } finally {
    await file.close();
  }
}
async function validateFile(
  path: string,
  parent: ConfigDirectory,
  kind?: FolderKind,
): Promise<void> {
  if (kind && soundKind(kind)) {
    if (!validSoundFile(basename(path))) fail("unsafe-file");
    const bytes = await read(path, soundSizeLimit(kind), parent);
    if (!matchesSoundHeader(path, bytes.subarray(0, 512))) fail("invalid-value");
    try {
      if (!validSoundDuration(kind, await soundDuration(bytes, basename(path))))
        fail("invalid-value");
    } catch {
      fail("invalid-value");
    }
  } else {
    const bytes = await read(path, 65536, parent);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
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
  const visitFile = async (
    file: string,
    label: string,
    parent: ConfigDirectory,
    kind?: FolderKind,
  ) => {
    try {
      await validateFile(file, parent, kind);
    } catch (error) {
      report(label, error);
    }
  };
  const folder = async (
    directory: string,
    label: string,
    kind: FolderKind,
    parent?: ConfigDirectory,
  ) => {
    try {
      if (parent) await checkDirectory(parent);
      const identity = await directoryIdentity(directory);
      if (parent && dirname(identity.canonical) !== parent.canonical) fail("unsafe-file");
      const entries = await opendir(directory);
      let count = 0;
      const limit = soundKind(kind)
        ? SOUND_FILE_LIMIT
        : kind === "config"
          ? 16
          : kind === "sounds"
            ? 4
            : 50;
      for await (const entry of entries) {
        if (++count > limit) {
          report(label, new ThemeValidationError("$", "too-many-files"));
          break;
        }
        await checkDirectory(identity);
        const file = join(directory, entry.name);
        const name = label ? `${label}/${entry.name}` : entry.name;
        let child: FolderKind | undefined;
        if (kind === "config") {
          // Foom writes these itself; validation covers only the agent-editable formats.
          if (FOOM_OWNED.includes(entry.name)) continue;
          if (entry.name === "settings.json") {
            await visitFile(file, name, identity, "settings");
            continue;
          }
          if (entry.name === "themes") child = "theme";
          if (entry.name === "terminal-themes") child = "terminal-theme";
          if (entry.name === "sounds") child = "sounds";
        } else if (kind === "sounds") child = SOUND_KINDS.find((value) => value === entry.name);
        else {
          if (soundKind(kind) && entry.name === ".gitkeep") continue;
          if (!(soundKind(kind) ? validSoundFile(entry.name) : validThemeFile(entry.name)))
            report(name, new ThemeValidationError("$", "unsafe-file"));
          else await visitFile(file, name, identity, kind);
          continue;
        }
        if (child) await folder(file, name, child, identity);
        else report(name, new ThemeValidationError("$", "unsafe-file"));
      }
      await checkDirectory(identity);
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
      await visitFile(
        absolute,
        basename(absolute),
        await directoryIdentity(dirname(absolute)),
        kind,
      );
    }
  } catch (error) {
    report(basename(absolute), error);
  }
  problems.sort((a, b) => a.file.localeCompare(b.file) || a.path.localeCompare(b.path));
  return { problems, code: status.ioError ? 2 : problems.length ? 1 : 0 };
}
