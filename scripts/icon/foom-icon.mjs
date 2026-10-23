// The Foom app icon: the ray-traced singularity on the dark squircle tile.
// `node scripts/icon/foom-icon.mjs <directory>` renders the PNG set, foom.icns and
// foom.ico from scratch. The build uses writeIcons(), which caches verified sets
// by source hash.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hex, renderBlackHole, toneMap } from "./blackhole.mjs";
import { encodeIcns, encodeIco, ICNS_TYPES } from "./containers.mjs";
import { downsample, encodePng, toDitheredBytes } from "./png.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
/** Git-ignored and outside every Electron build fingerprint input. */
export const CACHE_ROOT = join(here, "../../.cache/foom-icons");

/** Camera rolled −25° and 7° above the disk plane. */
const CAMERA = { roll: -25, inclination: 83 };
export const VIEW = {
  fov: 14,
  centerY: 0.5,
  rIn: 3.6,
  rOut: 13,
  falloff: 2.6,
  edge: 0.85,
  secondaryReach: 1.1,
  beaming: 1.4,
  texture: 0.3,
  maxOrder: 4,
  ringStrength: 2.5,
  ringWidth: 0.05,
  ...CAMERA,
};
export const TONE = { exposure: 3.6, heat: 0.5, bloom: 0.3 };
// Small sizes crop tighter, drop the streaks and fatten the photon ring so the
// shadow and its arch stay legible at 16 px.
export const SMALL_VIEW = {
  fov: 12.5,
  centerY: 0.5,
  rIn: 3.6,
  rOut: 11,
  falloff: 2.2,
  edge: 0.8,
  secondaryReach: 1.1,
  beaming: 1.2,
  texture: 0,
  maxOrder: 3,
  ringStrength: 3,
  ringWidth: 0.22,
  ...CAMERA,
};
export const SMALL_TONE = { exposure: 4, heat: 0.5, bloom: 0.2 };
/** Largest pixel size drawn from the small-size art. */
export const SMALL_MAX = 64;
export const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 256];

const SKY = hex("#05040A");
const SKY_CENTRE = hex("#160E30");

/** Squircle coverage for an N-pixel canvas: an 824 body on a 1024 grid, 4x4 subsamples. */
export function tileMask(N, body = 824 / 1024, n = 5) {
  const mask = new Float32Array(N * N);
  const a = (body * N) / 2;
  const c = N / 2;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let s = 0;
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const dx = Math.abs(x + (i + 0.5) / 4 - c) / a;
          const dy = Math.abs(y + (j + 0.5) / 4 - c) / a;
          if (dx ** n + dy ** n <= 1) s++;
        }
      mask[y * N + x] = s / 16;
    }
  return mask;
}

/** Renders the tile at N×N as straight-alpha float RGBA. */
export function iconImage(N, view, tone) {
  const rgba = toneMap(renderBlackHole({ width: N, height: N, ...view }), {
    ...tone,
    background: (u, v) => {
      const d = Math.min(1, Math.hypot(u - 0.5, v - 0.47) / 0.6);
      return SKY_CENTRE.map((c, i) => c + (SKY[i] - c) * d);
    },
  });
  const mask = tileMask(N);
  for (let k = 0; k < N * N; k++) rgba[k * 4 + 3] = mask[k];
  return rgba;
}

/**
 * Dithered 8-bit RGBA for every size in SIZES. Render sizes must divide evenly
 * into them.
 */
export function iconImages({ mainSize = 2048, smallSize = 768, render = iconImage } = {}) {
  const main = render(mainSize, VIEW, TONE);
  const small = render(smallSize, SMALL_VIEW, SMALL_TONE);
  return new Map(
    SIZES.map((size) => {
      const [source, n] = size <= SMALL_MAX ? [small, smallSize] : [main, mainSize];
      return [size, toDitheredBytes(downsample(source, n, n, n / size), size)];
    }),
  );
}

/** File name → contents: foom-<size>.png for each size, foom.icns and foom.ico. */
export function iconFiles(images) {
  const png = new Map();
  for (const [size, bytes] of images) png.set(size, encodePng(bytes, size, size));
  const need = (map, size) => {
    const value = map.get(size);
    if (!value) throw new Error(`Missing ${size} px icon image`);
    return value;
  };
  const files = new Map([...png].map(([size, data]) => [`foom-${size}.png`, data]));
  files.set(
    "foom.icns",
    encodeIcns(ICNS_TYPES.map(([type, size, scale]) => [type, need(png, size * scale)])),
  );
  files.set(
    "foom.ico",
    encodeIco(ICO_SIZES.map((size) => ({ size, bytes: need(images, size), png: need(png, size) }))),
  );
  return files;
}

/** Hash of the generator sources and Node version: the cache key for rendered icons. */
export async function sourceKey(directory = here) {
  const hash = createHash("sha256").update(process.version);
  for (const name of (await readdir(directory)).filter((n) => n.endsWith(".mjs")).sort())
    hash.update(name).update(await readFile(join(directory, name)));
  return hash.digest("hex").slice(0, 16);
}

/** Every file in an icon set. */
export const ICON_FILES = [...SIZES.map((size) => `foom-${size}.png`), "foom.icns", "foom.ico"];
const MANIFEST = "manifest.json";
/** Staging directories older than this are abandoned writes, not concurrent ones. */
const STALE_STAGING_MS = 60 * 60 * 1000;

const digest = (data) => createHash("sha256").update(data).digest("hex");

/**
 * Reads a cached set, or returns undefined unless the entry holds exactly the
 * manifest and ICON_FILES, each with its recorded size and SHA-256.
 */
async function readCached(cache) {
  try {
    const manifest = JSON.parse(await readFile(join(cache, MANIFEST), "utf8"));
    const names = (await readdir(cache)).filter((name) => name !== MANIFEST).sort();
    if (JSON.stringify(names) !== JSON.stringify([...ICON_FILES].sort())) return undefined;
    const files = new Map();
    for (const name of ICON_FILES) {
      const entry = manifest?.files?.[name];
      const data = await readFile(join(cache, name));
      if (entry?.size !== data.length || entry?.sha256 !== digest(data)) return undefined;
      files.set(name, data);
    }
    return Object.keys(manifest.files).length === ICON_FILES.length ? files : undefined;
  } catch {
    return undefined;
  }
}

/** Removes abandoned staging directories left by interrupted builds. */
async function pruneStaging(cacheRoot) {
  for (const name of await readdir(cacheRoot)) {
    if (!name.endsWith(".tmp")) continue;
    const path = join(cacheRoot, name);
    if (Date.now() - (await stat(path)).mtimeMs > STALE_STAGING_MS)
      await rm(path, { recursive: true, force: true });
  }
}

/**
 * Writes the icon set into `directory`. A cache entry for the current sources is
 * reused only if it verifies against its manifest; otherwise the set is rendered
 * and published atomically. Returns whether it rendered.
 */
export async function writeIcons(
  directory,
  { cacheRoot = CACHE_ROOT, generate = () => iconFiles(iconImages()) } = {},
) {
  const cache = join(cacheRoot, await sourceKey());
  let files = await readCached(cache);
  const rendered = !files;
  if (!files) {
    await mkdir(cacheRoot, { recursive: true });
    await pruneStaging(cacheRoot);
    files = generate();
    if (JSON.stringify([...files.keys()].sort()) !== JSON.stringify([...ICON_FILES].sort()))
      throw new Error("Icon generator produced an unexpected file set");
    const staging = `${cache}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(staging);
      const manifest = { files: {} };
      for (const [name, data] of files) {
        await writeFile(join(staging, name), data);
        manifest.files[name] = { size: data.length, sha256: digest(data) };
      }
      await writeFile(join(staging, MANIFEST), JSON.stringify(manifest, null, 2));
      // A damaged entry is replaced; a concurrent build's valid entry is kept.
      if (!(await readCached(cache))) await rm(cache, { recursive: true, force: true });
      await rename(staging, cache);
    } catch {
      // Caching is best effort (another build may have published first); the
      // verified set is already in memory.
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  for (const [name, data] of files) await writeFile(join(directory, name), data);
  return rendered;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: node scripts/icon/foom-icon.mjs <directory>");
  await mkdir(directory, { recursive: true });
  for (const [name, data] of iconFiles(iconImages())) await writeFile(join(directory, name), data);
}
