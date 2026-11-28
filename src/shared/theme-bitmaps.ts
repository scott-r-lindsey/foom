import type { ThemeBitmapFiles } from "./theme-bitmap";
import type { ThemeDiagnostic } from "./theme-file";
import { ThemeValidationError, themeKeys, themeRecord } from "./theme-validation";

export const themeBitmapSlots = ["empty", "sidebar", "tile-header"] as const;
export const legacyThemeBitmapSlots = ["board", "gutter"] as const;
export const themeBitmapSlotLimit = 8;
export const themeBitmapFits = ["cover", "contain", "tile"] as const;
export const themeBitmapAnchors = [
  "center",
  "top",
  "bottom",
  "left",
  "right",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;
export const themeBitmapFilePattern =
  "^[a-zA-Z0-9_-][a-zA-Z0-9 ._-]*\\.(?:[pP][nN][gG]|[jJ][pP][eE]?[gG]|[wW][eE][bB][pP])$";
export const themeFolderLimit = 50;
const bitmapFile = new RegExp(themeBitmapFilePattern, "u");
export function validThemeBitmapFile(file: string): boolean {
  return file.length <= 100 && bitmapFile.test(file);
}

function choice<T extends string>(values: readonly T[], value: unknown, path: string): T {
  const match = values.find((option) => option === value);
  if (!match) throw new ThemeValidationError(path, "invalid-value");
  return match;
}

function parseSlot(value: unknown, path: string): NonNullable<ThemeBitmapFiles["empty"]> {
  const image = themeRecord(value, path);
  themeKeys(image, [], path, ["file", "files", "opacity", "fit", "anchor"]);
  if (Object.hasOwn(image, "file") === Object.hasOwn(image, "files"))
    throw new ThemeValidationError(path, "invalid-value");
  const { file, files, opacity = 0.25, fit = "contain", anchor = "center" } = image;
  const list: unknown = Object.hasOwn(image, "files") ? files : [file];
  if (!Array.isArray(list) || list.length === 0)
    throw new ThemeValidationError(`${path}.files`, "invalid-value");
  if (list.length > themeBitmapSlotLimit)
    throw new ThemeValidationError(`${path}.files`, "too-many-files");
  const names = new Set<string>();
  const entries: readonly unknown[] = list;
  for (const name of entries) {
    if (typeof name !== "string" || !validThemeBitmapFile(name))
      throw new ThemeValidationError(
        `${path}.${Object.hasOwn(image, "files") ? "files" : "file"}`,
        "unsafe-file",
      );
    names.add(name);
  }
  if (typeof opacity !== "number" || !Number.isFinite(opacity) || opacity < 0.05 || opacity > 0.6)
    throw new ThemeValidationError(`${path}.opacity`, "invalid-value");
  return {
    files: [...names],
    opacity,
    fit: choice(themeBitmapFits, fit, `${path}.fit`),
    anchor: choice(themeBitmapAnchors, anchor, `${path}.anchor`),
  };
}

export function parseThemeBitmaps(value: unknown, warnings: ThemeDiagnostic[]): ThemeBitmapFiles {
  const images = themeRecord(value, "$.images");
  const slots = [...themeBitmapSlots, ...legacyThemeBitmapSlots];
  themeKeys(images, [], "$.images", slots);
  const result: ThemeBitmapFiles = {};
  for (const slot of slots) {
    if (!Object.hasOwn(images, slot)) continue;
    const path = `$.images.${slot}`;
    const image = parseSlot(images[slot], path);
    if (slot === "board" || slot === "gutter") {
      warnings.push({ file: "", path, reason: "legacy-image-slot", severity: "warning" });
      if (!Object.hasOwn(images, "empty")) {
        const empty = result.empty ?? image;
        result.empty = {
          ...empty,
          files: [...new Set([...empty.files, ...image.files])].slice(0, themeBitmapSlotLimit),
        };
      }
    } else result[slot] = image;
  }
  return result;
}

/** The decoder answered with a refusal, so retrying identical bytes is unnecessary. */
export class ImageDecodeRejection extends Error {}
