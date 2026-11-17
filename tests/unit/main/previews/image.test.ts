import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { expect, test } from "vitest";
import { IMAGE_CSP, imagePage, imageType, validImage } from "../../../../src/main/previews/image";
import { canonicalRoot, openDocument } from "../../../../src/main/previews/contained-files";
import { previewPath } from "../../../../src/main/previews/registry";

test("PNG, JPEG and WebP require matching content and a complete bounded decode", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-image-"));
  try {
    for (const [format, type] of [
      ["png", "image/png"],
      ["jpeg", "image/jpeg"],
      ["webp", "image/webp"],
    ] as const) {
      const body = await sharp({
        create: { width: 32, height: 24, channels: 4, background: "#9b6bff" },
      })
        .toFormat(format)
        .toBuffer();
      expect(imageType(body)).toBe(type);
      expect(await validImage(body, type)).toBe(true);
      expect(await validImage(body, "text/html")).toBe(false);
      expect(await validImage(body.subarray(0, 16), type)).toBe(false);
      await writeFile(join(root, `picture.${format}`), body);
      expect((await openDocument(canonicalRoot(root), `/picture.${format}`)).status).toBe(200);
      expect(previewPath(`picture.${format}`)).toBe(true);
    }
    await writeFile(join(root, "fake.png"), "<svg onload='alert(1)'/>");
    expect(await openDocument(canonicalRoot(root), "/fake.png")).toEqual({
      status: 400,
      reason: "invalid-image",
    });
    expect((await openDocument(canonicalRoot(root), "/missing.png")).status).toBe(404);
    await writeFile(join(root, "huge.png"), Buffer.alloc(16 * 1024 * 1024 + 1));
    expect((await openDocument(canonicalRoot(root), "/huge.png")).status).toBe(413);
    await writeFile(join(root, "unsafe.svg"), "<svg/>");
    expect(await openDocument(canonicalRoot(root), "/unsafe.svg")).toEqual({
      status: 400,
      reason: "unsupported-type",
    });
    await writeFile(join(root, "plain.html"), "hello");
    expect((await openDocument(canonicalRoot(root), "/plain.html")).status).toBe(200);
    if (process.platform !== "win32") {
      await symlink(join(root, "plain.html"), join(root, "alias.png"));
      expect(await openDocument(canonicalRoot(root), "/alias.png")).toEqual({
        status: 400,
        reason: "invalid-image",
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const huge = await sharp({
    create: { width: 4001, height: 4000, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  expect(await validImage(huge, "image/png")).toBe(false);
  for (const body of [Buffer.alloc(0), Buffer.from("<svg/>"), Buffer.from("GIF89a")]) {
    expect(imageType(body)).toBeUndefined();
    expect(await validImage(body, "image/png")).toBe(false);
  }
  expect(previewPath("unsafe.svg")).toBe(false);
});

test("image frame embeds only inert base64 data and uses a script-free isolated policy", () => {
  const page = imagePage(Buffer.from("</style><script>evil()</script>"), "image/png");
  expect(page).not.toContain("evil()");
  expect(page).toContain("Actual size");
  expect(page).toContain('name="size"');
  expect(IMAGE_CSP).toContain("default-src 'none'");
  expect(IMAGE_CSP).toContain("img-src data:");
  expect(IMAGE_CSP).not.toContain("script-src");
});

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

test("APNG animation chunks refuse with a fixed error, including malformed and orphan controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "foom-apng-"));
  try {
    const png = await sharp({
      create: { width: 3000, height: 3000, channels: 4, background: "white" },
    })
      .png()
      .toBuffer();
    const signature = png.subarray(0, 8);
    const header = png.subarray(8, 33);
    const idats: Buffer[] = [];
    for (let offset = 33; offset < png.length; ) {
      const end = offset + png.readUInt32BE(offset) + 12;
      if (png.toString("latin1", offset + 4, offset + 8) === "IDAT")
        idats.push(png.subarray(offset + 8, end - 4));
      offset = end;
    }
    const pixels = Buffer.concat(idats);
    const control = Buffer.alloc(8);
    control.writeUInt32BE(2); // Two 9-million-pixel frames exceed the total budget.
    const frame = Buffer.alloc(26);
    frame.writeUInt32BE(3000, 4);
    frame.writeUInt32BE(3000, 8);
    frame.writeUInt16BE(1, 20);
    frame.writeUInt16BE(10, 22);
    const secondFrame = Buffer.from(frame);
    secondFrame.writeUInt32BE(1);
    const sequence = Buffer.alloc(4);
    sequence.writeUInt32BE(2);
    const end = pngChunk("IEND", Buffer.alloc(0));
    const apng = Buffer.concat([
      signature,
      header,
      pngChunk("acTL", control),
      pngChunk("fcTL", frame),
      pngChunk("IDAT", pixels),
      pngChunk("fcTL", secondFrame),
      pngChunk("fdAT", Buffer.concat([sequence, pixels])),
      end,
    ]);
    // Sharp only sees the default frame and would otherwise accept these original bytes.
    expect((await sharp(apng, { animated: true }).raw().toBuffer()).length).toBe(3000 * 3000 * 4);
    for (const [name, body] of [
      ["two-frames", apng],
      [
        "malformed-actl",
        Buffer.concat([signature, header, pngChunk("acTL", Buffer.alloc(1)), png.subarray(33)]),
      ],
      [
        "orphan-fctl",
        Buffer.concat([signature, header, pngChunk("fcTL", frame), png.subarray(33)]),
      ],
      [
        "orphan-fdat",
        Buffer.concat([signature, header, pngChunk("fdAT", sequence), png.subarray(33)]),
      ],
    ] as const) {
      expect(await validImage(body, "image/png")).toBe(false);
      await writeFile(join(root, `${name}.png`), body);
      expect(await openDocument(canonicalRoot(root), `/${name}.png`)).toEqual({
        status: 400,
        reason: "invalid-image",
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PNG chunk scanning fails closed on malformed framing and checksums", async () => {
  const png = await sharp({
    create: { width: 1, height: 1, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const signature = png.subarray(0, 8);
  const badLength = Buffer.from(png);
  badLength.writeUInt32BE(0xffffffff, 8);
  const badCrc = Buffer.from(png);
  badCrc[32] = (badCrc[32] ?? 0) ^ 1;
  for (const body of [
    Buffer.alloc(16 * 1024 * 1024 + 1, png),
    badLength,
    badCrc,
    png.subarray(0, -12),
    png.subarray(0, -1),
    Buffer.concat([png, Buffer.from([0])]),
    Buffer.concat([signature, pngChunk("bad!", Buffer.alloc(0))]),
    Buffer.concat([signature, pngChunk("IDAT", Buffer.alloc(0))]),
    Buffer.concat([signature, pngChunk("IHDR", Buffer.alloc(0))]),
    Buffer.concat([png.subarray(0, -12), pngChunk("IEND", Buffer.from([0]))]),
  ])
    expect(await validImage(body, "image/png")).toBe(false);
});
