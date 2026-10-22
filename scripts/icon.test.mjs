import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { renderBlackHole, SHADOW_RADIUS, toneMap, toStraightAlpha } from "./icon/blackhole.mjs";
import { encodeIcns, encodeIco, ICNS_TYPES } from "./icon/containers.mjs";
import {
  CACHE_ROOT,
  iconFiles,
  iconImages,
  SIZES,
  SMALL_MAX,
  sourceKey,
  tileMask,
  writeIcons,
} from "./icon/foom-icon.mjs";
import { blur, crc32, downsample, encodePng, toBytes } from "./icon/png.mjs";

function readPng(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(
      png.readUInt32BE(offset + 8 + length),
      crc32(png.subarray(offset + 4, offset + 8 + length)),
    );
    chunks.push({ type, data });
    offset += 12 + length;
  }
  assert.deepEqual(
    chunks.map(({ type }) => type),
    ["IHDR", "IDAT", "IEND"],
  );
  const width = chunks[0].data.readUInt32BE(0);
  const height = chunks[0].data.readUInt32BE(4);
  const raw = inflateSync(chunks[1].data);
  const bytes = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width * 4 + 1)], 0);
    bytes.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, bytes };
}

// A cheap stand-in for the ray tracer: a vertical gradient tagged by render size.
const fakeRender = (N) => {
  const rgba = new Float32Array(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) rgba.set([y / N, N === 192 ? 1 : 0, 0, 1], (y * N + x) * 4);
  return rgba;
};

test("PNG encoding round-trips 8-bit RGBA with valid checksums", () => {
  assert.equal(crc32(Buffer.from("IEND")), 0xae426082);
  const bytes = toBytes(new Float32Array([0, 0.5, 1, 1, 2, -1, 0.25, 0]));
  assert.deepEqual([...bytes], [0, 128, 255, 255, 255, 0, 64, 0]);
  const png = readPng(encodePng(bytes, 2, 1));
  assert.equal(png.width, 2);
  assert.equal(png.height, 1);
  assert.deepEqual(png.bytes, bytes);
  assert.throws(() => encodePng(bytes, 3, 1), /does not match/);
});

test("downsampling weights colour by coverage and rejects uneven factors", () => {
  const src = new Float32Array([1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
  assert.deepEqual([...downsample(src, 2, 2, 2)], [1, 0, 0, 0.5]);
  assert.deepEqual([...downsample(new Float32Array(16), 2, 2, 2)], [0, 0, 0, 0]);
  assert.throws(() => downsample(src, 2, 2, 3), /Cannot downsample/);
});

test("blur conserves a flat field and spreads a point", () => {
  const flat = blur(new Float32Array(25).fill(0.5), 5, 5, 1);
  for (const value of flat) assert.ok(Math.abs(value - 0.5) < 1e-6);
  const point = new Float32Array(25);
  point[12] = 1;
  const spread = blur(point, 5, 5, 1);
  assert.ok(spread[12] < 1 && spread[11] > 0 && spread[11] === spread[13]);
});

test("the ray-traced shadow edge sits at the critical impact parameter", () => {
  const fov = 8;
  const width = 64;
  const render = renderBlackHole({ width, height: 4, fov, rIn: 6, rOut: 6.5 });
  const row = render.shadow.subarray(2 * width, 3 * width);
  const covered = row.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs((covered * (2 * fov)) / width / 2 - SHADOW_RADIUS) < 0.3);
  const centre = 2 * width + width / 2;
  assert.ok(Number.isNaN(render.lens[centre * 2]), "captured rays have no sky position");
  const edge = 2 * width;
  assert.ok(Math.abs(render.lens[edge * 2]) > fov, "escaping rays bend past the hole");
});

test("tone mapping composites opaquely over a sky or premultiplies for layering", () => {
  const render = renderBlackHole({ width: 16, height: 16, fov: 10, rIn: 4, rOut: 9, roll: -25 });
  const opaque = toneMap(render, { background: () => [0.1, 0.1, 0.2] });
  for (let k = 3; k < opaque.length; k += 4) assert.equal(opaque[k], 1);
  const layered = toneMap(render, {});
  const centre = (8 * 16 + 8) * 4;
  assert.equal(layered[centre + 3], render.shadow[8 * 16 + 8]);
  const straight = toStraightAlpha(layered);
  for (let k = 0; k < straight.length; k++) assert.ok(straight[k] >= 0 && straight[k] <= 1);
  assert.deepEqual([...toStraightAlpha(new Float32Array(4))], [0, 0, 0, 0]);
});

test("the tile mask is the squircle body, transparent at the corners", () => {
  const mask = tileMask(64);
  assert.equal(mask[0], 0);
  assert.equal(mask[32 * 64 + 32], 1);
  assert.equal(mask[32 * 64 + 2], 0);
  assert.ok(mask[32 * 64 + 6] > 0 && mask[32 * 64 + 6] <= 1);
});

test("small sizes use the simplified art and large sizes the full render", () => {
  const images = iconImages({ mainSize: 1024, smallSize: 192, render: fakeRender });
  assert.deepEqual([...images.keys()], SIZES);
  for (const [size, bytes] of images) {
    assert.equal(bytes.length, size * size * 4);
    assert.equal(bytes[1], size <= SMALL_MAX ? 255 : 0);
  }
});

test("the icon set holds every PNG plus valid ICO and ICNS containers", () => {
  const images = iconImages({ mainSize: 1024, smallSize: 192, render: fakeRender });
  const files = iconFiles(images);
  assert.deepEqual(
    [...files.keys()].sort(),
    [...SIZES.map((size) => `foom-${size}.png`), "foom.icns", "foom.ico"].sort(),
  );
  for (const size of SIZES) {
    const png = readPng(files.get(`foom-${size}.png`));
    assert.equal(png.width, size);
    assert.deepEqual(png.bytes, images.get(size));
  }

  const icns = files.get("foom.icns");
  assert.equal(icns.toString("ascii", 0, 4), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  const types = [];
  for (let offset = 8; offset < icns.length; offset += icns.readUInt32BE(offset + 4)) {
    const type = icns.toString("ascii", offset, offset + 4);
    const [, size, scale] = ICNS_TYPES.find(([name]) => name === type);
    const png = icns.subarray(offset + 8, offset + icns.readUInt32BE(offset + 4));
    assert.deepEqual(png, files.get(`foom-${size * scale}.png`));
    types.push(type);
  }
  assert.deepEqual(
    types,
    ICNS_TYPES.map(([type]) => type),
  );

  const ico = files.get("foom.ico");
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 6]);
  const sizes = [];
  for (let i = 0; i < 6; i++) {
    const entry = 6 + i * 16;
    const size = ico[entry] || 256;
    const data = ico.subarray(
      ico.readUInt32LE(entry + 12),
      ico.readUInt32LE(entry + 12) + ico.readUInt32LE(entry + 8),
    );
    sizes.push(size);
    if (size === 256) {
      assert.deepEqual(data, files.get("foom-256.png"));
      continue;
    }
    assert.equal(data.readUInt32LE(0), 40);
    assert.deepEqual([data.readInt32LE(4), data.readInt32LE(8)], [size, size * 2]);
    // The first DIB row is the image's bottom row, stored BGRA.
    const source = images.get(size);
    const bottom = (size - 1) * size * 4;
    assert.deepEqual(
      [...data.subarray(40, 44)],
      [source[bottom + 2], source[bottom + 1], source[bottom], source[bottom + 3]],
    );
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 256]);
});

test("ICO transparent pixels are set in the legacy AND mask", () => {
  const bytes = new Uint8Array(4 * 4 * 4).fill(255);
  bytes[3] = 0;
  const ico = encodeIco([{ size: 4, bytes, png: Buffer.alloc(0) }]);
  const dib = ico.subarray(ico.readUInt32LE(18));
  const mask = 40 + 4 * 4 * 4;
  // Top-left pixel lives in the last (bottom-up) mask row.
  assert.equal(dib[mask + 3 * 4], 0x80);
  assert.equal(dib[mask], 0);
  assert.throws(() => encodeIco([{ size: 300, bytes, png: Buffer.alloc(0) }]), /Unsupported/);
  assert.throws(() => encodeIco([{ size: 8, bytes, png: Buffer.alloc(0) }]), /does not match/);
  assert.throws(() => encodeIcns([["bad!", Buffer.alloc(0)]]), /Invalid ICNS type/);
  assert.throws(() => iconFiles(new Map([[16, new Uint8Array(16 * 16 * 4)]])), /Missing/);
});

test("builds render once per generator source and reuse the cached set", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "foom-icons-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  let renders = 0;
  const generate = () => {
    renders++;
    return new Map([
      ["foom.ico", Buffer.from("ico")],
      ["foom-16.png", Buffer.from("png")],
    ]);
  };
  const cacheRoot = join(scratch, "cache");
  assert.equal(await writeIcons(join(scratch, "a"), { cacheRoot, generate }), true);
  assert.equal(await writeIcons(join(scratch, "b"), { cacheRoot, generate }), false);
  assert.equal(renders, 1);
  assert.deepEqual((await readdir(join(scratch, "b"))).sort(), ["foom-16.png", "foom.ico"]);
  assert.equal(await readFile(join(scratch, "b", "foom.ico"), "utf8"), "ico");
  assert.deepEqual(await readdir(cacheRoot), [await sourceKey()]);
});

test("a failed render leaves no cached set behind", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "foom-icons-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cacheRoot = join(scratch, "cache");
  const failure = new Error("render failed");
  await assert.rejects(
    writeIcons(join(scratch, "out"), {
      cacheRoot,
      generate: () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(await readdir(cacheRoot), []);
});

test("the cache key follows the generator sources", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "foom-icon-src-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(scratch, "a.mjs"), "1");
  await writeFile(join(scratch, "notes.txt"), "ignored");
  const first = await sourceKey(scratch);
  await writeFile(join(scratch, "notes.txt"), "still ignored");
  assert.equal(await sourceKey(scratch), first);
  await writeFile(join(scratch, "a.mjs"), "2");
  assert.notEqual(await sourceKey(scratch), first);
});

test("the icon cache stays outside the Electron build fingerprint", async () => {
  const source = await readFile(join(import.meta.dirname, "validation-fingerprint.mjs"), "utf8");
  const inputs = source.match(/return fingerprint\(\[([^\]]*)\]/)[1];
  const top = relative(join(import.meta.dirname, ".."), CACHE_ROOT).split(sep)[0];
  assert.equal(top, ".cache");
  assert.doesNotMatch(inputs, /\.cache/);
});
