import { createHash, createHmac, randomBytes } from "node:crypto";
import { readThemeDirectory } from "../theme-directory";
import { IMAGE_BYTES } from "../../shared/image-paste";
import { colorDistance } from "../../shared/theme-colors";
import {
  ImageDecodeRejection,
  themeBitmapSlots,
  themeFolderLimit,
  validThemeBitmapFile,
} from "../../shared/theme-bitmaps";
import { ThemeValidationError, validThemeFile } from "../../shared/theme-validation";
import type {
  DecodedThemeBitmap,
  ThemeBitmapAsset,
  ThemeBitmapSnapshot,
} from "../../shared/theme-bitmap";
import type { ParsedThemeFile, ThemeDiagnostic } from "../../shared/theme-file";
import { readThemeFile } from "./files";

export class ThemeBitmaps {
  private readonly key = randomBytes(32);
  private readonly cancel = new AbortController();
  private readonly decoded = new Map<string, Promise<DecodedThemeBitmap> | number>();

  constructor(
    private readonly directory: string,
    private readonly normalize: (
      bytes: Uint8Array,
      signal: AbortSignal,
    ) => Promise<DecodedThemeBitmap>,
  ) {}

  async load(parsed: Extract<ParsedThemeFile, { kind: "theme" }>): Promise<ThemeBitmapSnapshot> {
    const diagnostics: ThemeDiagnostic[] = [];
    const slots: ThemeBitmapSnapshot["slots"] = {};
    let count: number | undefined;
    let folderReason: ThemeDiagnostic["reason"] = "image-unavailable";
    try {
      const files = await readThemeDirectory(this.directory);
      count = files.filter(
        (entry) =>
          entry.isFile() && (validThemeFile(entry.name) || validThemeBitmapFile(entry.name)),
      ).length;
    } catch (error) {
      if (error instanceof ThemeValidationError) folderReason = error.reason;
    }
    for (const slot of themeBitmapSlots) {
      const pieces = parsed.images?.[slot];
      if (!pieces) continue;
      const path = `$.images.${slot}`;
      const report = (reason: ThemeDiagnostic["reason"], severity: "warning" | "error") => {
        diagnostics.push({ file: "", path, reason, severity });
      };
      if (count === undefined) {
        report(folderReason, "error");
        continue;
      }
      if (count > themeFolderLimit) {
        report("too-many-files", "error");
        continue;
      }
      const { colors: globalColors, areas } = parsed.theme;
      const headerArea = areas?.["tile-headers"] ?? areas?.tiles;
      const overrides =
        slot === "empty"
          ? [areas?.board, areas?.tiles, areas?.["tile-headers"]]
          : [slot === "tile-header" ? headerArea : areas?.sidebar];
      const palettes = [globalColors, ...overrides.map((area) => ({ ...globalColors, ...area }))];
      const assets: ThemeBitmapAsset[] = [];
      const occurrences = new Map<string, number>();
      for (const { file, ...style } of pieces) {
        const occurrence = occurrences.get(file) ?? 0;
        occurrences.set(file, occurrence + 1);
        let bytes: Buffer;
        try {
          bytes = await readThemeFile(this.directory, file, IMAGE_BYTES, false);
        } catch (error) {
          report(
            error instanceof ThemeValidationError ? error.reason : "image-unavailable",
            "error",
          );
          continue;
        }
        const source = createHash("sha256").update(bytes).digest("hex");
        let bitmap: DecodedThemeBitmap;
        try {
          bitmap = await this.decode(source, bytes);
        } catch {
          report("image-format", "error");
          continue;
        }
        const { colors, png } = bitmap;
        if (
          colors.some((color) =>
            palettes.some((palette) =>
              [
                palette.attention,
                palette["attention-ink"],
                palette.failed,
                palette["failed-ink"],
              ].some((status) => colorDistance(color, status) < 40),
            ),
          )
        )
          report("image-status-color", "warning");
        // Repeated references can specify distinct placements for the same file.
        const id = createHmac("sha256", this.key)
          .update(JSON.stringify([slot, file, source, occurrence]))
          .digest("hex");
        assets.push({ paint: { id, ...style }, png });
      }
      if (assets.length) slots[slot] = assets;
    }
    return { slots, diagnostics };
  }

  private decode(source: string, bytes: Uint8Array): Promise<DecodedThemeBitmap> {
    const cached = this.decoded.get(source);
    if (typeof cached === "number") {
      if (performance.now() < cached)
        return Promise.reject(new Error("Image decode retry deferred"));
      this.decoded.delete(source);
    } else if (cached) return cached;
    if (this.decoded.size === themeFolderLimit) {
      const oldest = this.decoded.keys().next().value;
      if (oldest) this.decoded.delete(oldest);
    }
    const result = this.normalize(bytes, this.cancel.signal).catch((error: unknown) => {
      // Cache deterministic refusals. For exit, timeout or launch failures, keep
      // only a cooldown and let a later refresh try again. Never schedule a retry.
      if (!(error instanceof ImageDecodeRejection) && this.decoded.get(source) === result)
        this.decoded.set(source, performance.now() + 1_000);
      throw error;
    });
    this.decoded.set(source, result);
    return result;
  }

  dispose(): void {
    this.cancel.abort();
    this.decoded.clear();
  }
}

/** The board session can read only an exact ID from the active snapshot. */
export function themeBitmapResponse(
  request: Request,
  image: (id: string) => Uint8Array | undefined,
): Response {
  const match = /^foom-theme:\/\/bitmap\/([a-f0-9]{64})$/u.exec(request.url);
  const id = match?.[1];
  const png = request.method === "GET" && id ? image(id) : undefined;
  if (!png) return new Response(null, { status: 404 });
  return new Response(Uint8Array.from(png), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
