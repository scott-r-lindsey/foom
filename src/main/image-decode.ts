import sharp from "sharp";
import type { DecodedThemeBitmap } from "../shared/theme-bitmap";
import {
  IMAGE_BYTES,
  IMAGE_PIXELS,
  imageDimensions,
  imagePng,
  rasterImageFormat,
} from "../shared/image-paste";

/** Called only in the disposable decoder process. Accept bytes, never a path/URL. */
async function decode(bytes: Uint8Array, allowGif: boolean): Promise<Buffer> {
  if (bytes.length === 0 || bytes.length > IMAGE_BYTES) throw new Error("Image size refused");
  const input = Buffer.from(bytes);
  const format = rasterImageFormat(input);
  if (!format || (!allowGif && format === "gif")) throw new Error("Image format refused");
  sharp.cache(false);
  sharp.concurrency(1);
  const image = sharp(input, {
    limitInputPixels: IMAGE_PIXELS,
    limitInputChannels: 4,
    pages: 1,
    page: 0,
    failOn: "warning",
  });
  const metadata = await image.metadata();
  if (metadata.format !== format || !imageDimensions(metadata.width, metadata.height))
    throw new Error("Image dimensions refused");
  const png = await image.autoOrient().png().toBuffer();
  if (!imagePng(png)) throw new Error("Image output refused");
  return png;
}

export function decodeImage(bytes: Uint8Array): Promise<Uint8Array> {
  return decode(bytes, true);
}

export async function decodeThemeBitmap(bytes: Uint8Array): Promise<DecodedThemeBitmap> {
  const png = await decode(bytes, false);
  const sample = await sharp(png)
    .resize(64, 64, { fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer();
  const buckets = new Map<number, { weight: number; rgb: number[] }>();
  for (let index = 0; index < sample.length; index += 4) {
    const rgb = [...sample.subarray(index, index + 3)];
    const alpha = sample.readUInt8(index + 3);
    if (alpha < 32) continue;
    const key = rgb.reduce((key, channel) => key * 8 + (channel >> 5), 0);
    const bucket = buckets.get(key) ?? { weight: 0, rgb: [0, 0, 0] };
    bucket.weight += alpha;
    bucket.rgb = bucket.rgb.map((sum, channel) => sum + (rgb[channel] ?? 0) * alpha);
    buckets.set(key, bucket);
  }
  const colors = [...buckets.values()]
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 3)
    .map(
      ({ weight, rgb }) =>
        "#" +
        rgb
          .map((sum) =>
            Math.round(sum / weight)
              .toString(16)
              .padStart(2, "0"),
          )
          .join(""),
    );
  return { png, colors };
}
