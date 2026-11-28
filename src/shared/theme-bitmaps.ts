import type { ThemeBitmapFiles, ThemeBitmapPiece, ThemeBitmapStyle } from "./theme-bitmap";
import type { ThemeDiagnostic } from "./theme-file";
import { ThemeValidationError, themeKeys, themeRecord } from "./theme-validation";

export const themeBitmapSlots = ["empty", "sidebar", "tile-header"] as const;
export const legacyThemeBitmapSlots = ["board", "gutter"] as const;
export const themeBitmapSlotLimit = 8;
export const themeBitmapFits = ["cover", "contain", "tile", "none"] as const;
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

const paintKeys = ["opacity", "fit", "anchor", "size"];

function optionalSize(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 5 || value > 100)
    throw new ThemeValidationError(`${path}.size`, "invalid-value");
  return value;
}

function style(
  value: Record<string, unknown>,
  path: string,
  defaults: ThemeBitmapStyle,
): ThemeBitmapStyle {
  const { opacity = defaults.opacity, fit = defaults.fit, anchor = defaults.anchor } = value;
  if (typeof opacity !== "number" || !Number.isFinite(opacity) || opacity < 0.05 || opacity > 0.6)
    throw new ThemeValidationError(`${path}.opacity`, "invalid-value");
  return {
    opacity,
    fit: choice(themeBitmapFits, fit, `${path}.fit`),
    anchor: choice(themeBitmapAnchors, anchor, `${path}.anchor`),
  };
}

function parseSlot(value: unknown, path: string): readonly ThemeBitmapPiece[] {
  const image = themeRecord(value, path);
  themeKeys(image, [], path, ["file", "files", ...paintKeys]);
  const single = Object.hasOwn(image, "file");
  if (single === Object.hasOwn(image, "files"))
    throw new ThemeValidationError(path, "invalid-value");
  const list = single ? [image["file"]] : image["files"];
  if (!Array.isArray(list) || list.length === 0)
    throw new ThemeValidationError(`${path}.files`, "invalid-value");
  if (list.length > themeBitmapSlotLimit)
    throw new ThemeValidationError(`${path}.files`, "too-many-files");

  const defaults = style(image, path, { opacity: 0.25, fit: "contain", anchor: "center" });
  const defaultSize = optionalSize(image["size"], path);
  const entries: readonly unknown[] = list;
  const pieces = entries.map((entry) => {
    const piecePath = `${path}.${single ? "file" : "files"}`;
    if (typeof entry === "string" || single) {
      if (typeof entry !== "string" || !validThemeBitmapFile(entry))
        throw new ThemeValidationError(piecePath, "unsafe-file");
      return {
        file: entry,
        ...defaults,
        ...(defaults.fit === "none" && defaultSize !== undefined && { size: defaultSize }),
      };
    }
    const piece = themeRecord(entry, piecePath);
    themeKeys(piece, ["file"], piecePath, paintKeys);
    const file = piece["file"];
    if (typeof file !== "string" || !validThemeBitmapFile(file))
      throw new ThemeValidationError(`${piecePath}.file`, "unsafe-file");
    const paint = style(piece, piecePath, defaults);
    const size = optionalSize(piece["size"], piecePath);
    if (size !== undefined && paint.fit !== "none")
      throw new ThemeValidationError(`${piecePath}.size`, "invalid-value");
    const effectiveSize = paint.fit === "none" ? (size ?? defaultSize) : undefined;
    return { file, ...paint, ...(effectiveSize !== undefined && { size: effectiveSize }) };
  });
  if (
    defaultSize !== undefined &&
    defaults.fit !== "none" &&
    !pieces.some(({ fit }) => fit === "none")
  )
    throw new ThemeValidationError(`${path}.size`, "invalid-value");
  return uniquePieces(pieces);
}

function uniquePieces(pieces: readonly ThemeBitmapPiece[]): ThemeBitmapPiece[] {
  return [...new Map(pieces.map((piece) => [JSON.stringify(piece), piece])).values()];
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
        result.empty = uniquePieces([...(result.empty ?? []), ...image]).slice(
          0,
          themeBitmapSlotLimit,
        );
      }
    } else result[slot] = image;
  }
  return result;
}

/** The decoder answered with a refusal, so retrying identical bytes is unnecessary. */
export class ImageDecodeRejection extends Error {}
