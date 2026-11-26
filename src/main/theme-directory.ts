import type { Dirent } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { ThemeValidationError } from "../shared/theme-validation";

export const themeDirectoryEntryLimit = 512;

/** Bound enumeration separately from the budget for eligible theme files. */
export async function readThemeDirectory(path: string): Promise<Dirent[]> {
  if (!(await lstat(path)).isDirectory()) throw new Error("Theme directory unavailable");
  const entries: Dirent[] = [];
  const directory = await opendir(path);
  for await (const entry of directory) {
    if (entries.length === themeDirectoryEntryLimit)
      throw new ThemeValidationError("$", "too-many-files");
    entries.push(entry);
  }
  return entries;
}
