import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { renderBlackHole, SHADOW_RADIUS, toneMap, toStraightAlpha } from "./icon/blackhole.mjs";
import { encodeIcns, encodeIco, ICNS_TYPES } from "./icon/containers.mjs";
import {
  CACHE_ROOT,
  ICON_FILES,
  iconFiles,
  iconImages,
  SIZES,
  SMALL_MAX,
  sourceKey,
  tileMask,
  writeIcons,
} from "./icon/foom-icon.mjs";
import { blur, crc32, downsample, encodePng, toBytes, toDitheredBytes } from "./icon/png.mjs";

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

test("ordered dithering splits in-between levels evenly and leaves alpha alone", () => {
  const flat = new Float32Array(4 * 4 * 4).fill(100.5 / 255);
  const bytes = toDitheredBytes(flat, 4);
  for (let channel = 0; channel < 3; channel++) {
    const values = [...bytes].filter((_, k) => k % 4 === channel);
    assert.equal(values.filter((v) => v === 101).length, 8);
    assert.equal(values.filter((v) => v === 100).length, 8);
  }
  for (let k = 3; k < bytes.length; k += 4) assert.equal(bytes[k], 101);
  const exact = toDitheredBytes(new Float32Array([0, 1, 40 / 255, 1, 2, -1, 0, 0]), 2);
  assert.deepEqual([...exact], [...toBytes(new Float32Array([0, 1, 40 / 255, 1, 2, -1, 0, 0]))]);
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

async function cacheScratch(t) {
  const scratch = await mkdtemp(join(tmpdir(), "foom-icons-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  let renders = 0;
  const generate = () => {
    renders++;
    return new Map(ICON_FILES.map((name) => [name, Buffer.from(`${name}:${renders}`)]));
  };
  const cacheRoot = join(scratch, "cache");
  const options = { cacheRoot, generate };
  const entry = join(cacheRoot, await sourceKey());
  const out = join(scratch, "out");
  return { scratch, options, entry, out, renders: () => renders };
}

async function assertCompleteSet(directory, render) {
  assert.deepEqual((await readdir(directory)).sort(), [...ICON_FILES].sort());
  for (const name of ICON_FILES)
    assert.equal(await readFile(join(directory, name), "utf8"), `${name}:${render}`);
}

test("builds render once per generator source and reuse the verified set", async (t) => {
  const { options, entry, out, renders } = await cacheScratch(t);
  assert.equal(await writeIcons(out, options), true);
  assert.equal(await writeIcons(out, options), false);
  assert.equal(renders(), 1);
  await assertCompleteSet(out, 1);
  assert.deepEqual(await readdir(options.cacheRoot), [basename(entry)]);
  const manifest = JSON.parse(await readFile(join(entry, "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.files).sort(), [...ICON_FILES].sort());
  assert.equal(manifest.files["foom.ico"].size, "foom.ico:1".length);
});

test("a damaged cache entry is discarded and rendered again", async (t) => {
  const damage = {
    "a tampered file": (entry) => writeFile(join(entry, "foom-512.png"), "foom-512.png:X"),
    "a missing file": (entry) => rm(join(entry, "foom-16.png")),
    "an extra file": (entry) => writeFile(join(entry, "stray.png"), "stray"),
    "a missing manifest": (entry) => rm(join(entry, "manifest.json")),
    "a garbled manifest": (entry) => writeFile(join(entry, "manifest.json"), "{not json"),
    "a manifest missing an entry": async (entry) => {
      const path = join(entry, "manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      delete manifest.files["foom.icns"];
      await writeFile(path, JSON.stringify(manifest));
    },
    "a manifest with an extra entry": async (entry) => {
      const path = join(entry, "manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.files["stray.png"] = { size: 1, sha256: "0" };
      await writeFile(path, JSON.stringify(manifest));
    },
    "a null manifest": (entry) => writeFile(join(entry, "manifest.json"), "null"),
  };
  for (const [name, corrupt] of Object.entries(damage)) {
    await t.test(name, async (t) => {
      const { options, entry, out, renders } = await cacheScratch(t);
      await writeIcons(out, options);
      await corrupt(entry);
      assert.equal(await writeIcons(out, options), true);
      assert.equal(renders(), 2);
      await assertCompleteSet(out, 2);
      // The replacement entry verifies, so the next build reuses it.
      assert.equal(await writeIcons(out, options), false);
      await assertCompleteSet(out, 2);
    });
  }
});

test("an interrupted write is never reused and is pruned once abandoned", async (t) => {
  const { options, entry, out, renders } = await cacheScratch(t);
  const fresh = `${entry}.1.a.tmp`;
  const abandoned = `${entry}.2.b.tmp`;
  for (const staging of [fresh, abandoned]) {
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "foom-16.png"), "partial");
  }
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(abandoned, old, old);
  assert.equal(await writeIcons(out, options), true);
  assert.equal(renders(), 1);
  await assertCompleteSet(out, 1);
  assert.deepEqual((await readdir(options.cacheRoot)).sort(), [basename(entry), basename(fresh)]);
});

test("concurrent builds both write a complete set", async (t) => {
  const { options, out, scratch } = await cacheScratch(t);
  const other = join(scratch, "other");
  await Promise.all([writeIcons(out, options), writeIcons(other, options)]);
  for (const directory of [out, other])
    assert.deepEqual((await readdir(directory)).sort(), [...ICON_FILES].sort());
  assert.equal(await writeIcons(out, options), false);
  assert.equal(
    (await readdir(options.cacheRoot)).filter((name) => name.endsWith(".tmp")).length,
    0,
  );
});

test("a failed or incomplete render leaves no cached set behind", async (t) => {
  const { options, out } = await cacheScratch(t);
  const failure = new Error("render failed");
  await assert.rejects(
    writeIcons(out, {
      ...options,
      generate: () => {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  await assert.rejects(
    writeIcons(out, { ...options, generate: () => new Map([["foom.ico", Buffer.from("ico")]]) }),
    /unexpected file set/,
  );
  assert.deepEqual(await readdir(options.cacheRoot), []);
});

test("the cache key follows the generator sources", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "foom-icon-src-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
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

test("flight bake is reproducible, opaque map bytes survive PNG decoding, and assets stay modest", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "foom-flight-bake-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync(process.execPath, ["scripts/bake-flight.mjs", directory]);
  const names = ["emission.png", "lens.png", "singularity.png", "sky.png"];
  assert.deepEqual((await readdir(directory)).sort(), names);
  let total = 0;
  for (const name of names) {
    const baked = await readFile(join(directory, name));
    assert.deepEqual(baked, await readFile(join("src/renderer/art", name)));
    total += baked.length;
  }
  assert.ok(total < 1_100_000);
  for (const name of ["emission.png", "singularity.png", "sky.png"]) {
    const { bytes } = readPng(await readFile(join(directory, name)));
    for (let k = 0; k < bytes.length; k += 4)
      assert.ok(bytes[k + 2] >= bytes[k] && bytes[k] >= bytes[k + 1], `${name}: violet-white ramp`);
  }
  const map = readPng(await readFile(join(directory, "lens.png")));
  assert.equal(map.width, 1024);
  assert.equal(map.height, 512);
  // At the shadow, escape visibility is zero and actual coverage is opaque.
  // No colour bytes can be lost to browser PNG alpha premultiplication.
  for (const x of [256, 768]) {
    const k = (256 * 1024 + x) * 4;
    assert.equal(map.bytes[k + 2], x === 256 ? 0 : 255);
    assert.equal(map.bytes[k + 3], 255);
  }
  assert.ok(map.bytes.some((v, k) => k % 4 === 2 && v === 255));
  const still = readPng(await readFile(join(directory, "singularity.png")));
  assert.equal(still.bytes[(256 * 512 + 256) * 4 + 3], 255);
  assert.ok(still.bytes.some((v, k) => k % 4 === 3 && v === 0));
});
