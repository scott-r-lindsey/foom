import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Size } from "./appearance";

/** Main-only window geometry; never exposed through settings IPC. */
export async function loadWindowSize(userData: string): Promise<Size | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(userData, "window-size.json"), "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    if (!("width" in value) || !("height" in value)) return undefined;
    const { width, height } = value;
    if (
      typeof width !== "number" ||
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      typeof height !== "number" ||
      !Number.isSafeInteger(height) ||
      height <= 0
    )
      return undefined;
    return { width, height };
  } catch {
    return undefined;
  }
}

/** Save only dimensions, atomically, before completing a successful quit. */
export async function saveWindowSize(userData: string, size: Size): Promise<void> {
  await mkdir(userData, { recursive: true, mode: 0o700 });
  const file = join(userData, "window-size.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ width: size.width, height: size.height }), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
