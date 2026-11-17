import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
