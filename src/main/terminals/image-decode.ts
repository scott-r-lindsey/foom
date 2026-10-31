import sharp from "sharp";
import { IMAGE_BYTES, IMAGE_PIXELS, imageDimensions, imagePng } from "../../shared/image-paste";

/** Called only in the disposable decoder process. Accept bytes, never a path/URL. */
export async function decodeImage(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length === 0 || bytes.length > IMAGE_BYTES) throw new Error("Image size refused");
  const input = Buffer.from(bytes);
  const signature = input.subarray(0, 12);
  const format = signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "png"
    : signature[0] === 255 && signature[1] === 216 && signature[2] === 255
      ? "jpeg"
      : signature.subarray(0, 4).toString() === "RIFF" &&
          signature.subarray(8, 12).toString() === "WEBP"
        ? "webp"
        : /^GIF8[79]a/u.test(signature.toString())
          ? "gif"
          : undefined;
  if (!format) throw new Error("Image format refused");
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
