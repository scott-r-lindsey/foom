import { expect, test } from "vitest";
import sharp from "sharp";
import { decodeImage } from "../../../../src/main/terminals/image-decode";
import { IMAGE_BYTES, imagePng } from "../../../../src/shared/image-paste";

test("decodes PNG JPEG WebP GIF to stripped PNG and retains alpha", async () => {
  const image = sharp({
    create: { width: 4, height: 3, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } },
  });
  for (const format of ["png", "jpeg", "webp", "gif"] as const) {
    const encoded = await image
      .clone()
      .withMetadata({ exif: { IFD0: { Artist: "private" } } })
      .toFormat(format)
      .toBuffer();
    const result = await decodeImage(encoded);
    expect(imagePng(result)).toBe(true);
    const metadata = await sharp(result).metadata();
    expect(metadata.width).toBe(4);
    expect(metadata.height).toBe(3);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    if (format === "png") expect(metadata.hasAlpha).toBe(true);
  }
});
test("rejects unsupported, truncated, oversized and excessive pixel/axis data", async () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(IMAGE_BYTES + 1),
    Buffer.from("<svg/>"),
    Buffer.from("GIF89a"),
    Buffer.from([255, 216, 255]),
  ])
    await expect(decodeImage(bytes)).rejects.toThrow();
  const tooWide = await sharp({
    create: { width: 8193, height: 1, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await expect(decodeImage(tooWide)).rejects.toThrow("dimensions");
  const tooMany = await sharp({
    create: { width: 4001, height: 4000, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await expect(decodeImage(tooMany)).rejects.toThrow();
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  await expect(decodeImage(png.subarray(0, 40))).rejects.toThrow();
});
test("animation publishes only the first composited frame", async () => {
  const pixels = Buffer.from([255, 255, 0, 255, 255, 0, 0, 255, 255, 0, 255, 255]);
  const gif = await sharp(pixels, { raw: { width: 2, height: 2, channels: 3, pageHeight: 1 } })
    .gif({ loop: 0 })
    .toBuffer();
  const output = await decodeImage(gif);
  const { data, info } = await sharp(output)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect(info.height).toBe(1);
  expect([...data]).toEqual([255, 255, 0, 255, 255, 0]);
});

test("applies orientation and refuses a normalized PNG above the output byte cap", async () => {
  const { randomBytes } = await import("node:crypto");
  const oriented = await sharp({ create: { width: 4, height: 3, channels: 3, background: "red" } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const rotated = await sharp(await decodeImage(oriented)).metadata();
  expect(rotated.width).toBe(3);
  expect(rotated.height).toBe(4);
  expect(rotated.orientation).toBeUndefined();
  const input = await sharp(randomBytes(1400 * 1400 * 3), {
    raw: { width: 1400, height: 1400, channels: 3 },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
  expect(input.length).toBeLessThan(IMAGE_BYTES);
  await expect(decodeImage(input)).rejects.toThrow("output");
});
