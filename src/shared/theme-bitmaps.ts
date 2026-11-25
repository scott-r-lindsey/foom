import type { ThemeBitmapFiles, ThemeBitmapStyle } from "./theme-bitmap";
import { ThemeValidationError, themeKeys, themeRecord } from "./theme-validation";

export const themeBitmapSlots = ["board", "gutter", "sidebar"] as const;
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

export function parseThemeBitmaps(value: unknown): ThemeBitmapFiles {
  const images = themeRecord(value, "$.images");
  themeKeys(images, [], "$.images", themeBitmapSlots);
  const result: ThemeBitmapFiles = {};
  for (const slot of themeBitmapSlots) {
    if (!Object.hasOwn(images, slot)) continue;
    const path = `$.images.${slot}`;
    const image = themeRecord(images[slot], path);
    themeKeys(image, ["file"], path, ["opacity", "fit", "anchor"]);
    const { file, opacity = 0.25, fit = "contain", anchor = "center" } = image;
    if (typeof file !== "string" || !validThemeBitmapFile(file))
      throw new ThemeValidationError(`${path}.file`, "unsafe-file");
    if (typeof opacity !== "number" || !Number.isFinite(opacity) || opacity < 0.05 || opacity > 0.6)
      throw new ThemeValidationError(`${path}.opacity`, "invalid-value");
    const style: ThemeBitmapStyle = {
      opacity,
      fit: choice(themeBitmapFits, fit, `${path}.fit`),
      anchor: choice(themeBitmapAnchors, anchor, `${path}.anchor`),
    };
    result[slot] = { file, ...style };
  }
  return result;
}
