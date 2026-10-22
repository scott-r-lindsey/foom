// The Foom app icon: the ray-traced singularity on the dark squircle tile.
// `node scripts/icon/foom-icon.mjs <directory>` renders the PNG set, foom.icns and
// foom.ico from scratch. The build uses writeIcons(), which caches by source hash.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hex, renderBlackHole, toneMap } from "./blackhole.mjs";
import { encodeIcns, encodeIco, ICNS_TYPES } from "./containers.mjs";
import { downsample, encodePng, toBytes } from "./png.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));

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

/** 8-bit RGBA for every size in SIZES. Render sizes must divide evenly into them. */
export function iconImages({ mainSize = 2048, smallSize = 768, render = iconImage } = {}) {
  const main = render(mainSize, VIEW, TONE);
  const small = render(smallSize, SMALL_VIEW, SMALL_TONE);
  return new Map(
    SIZES.map((size) => {
      const [source, n] = size <= SMALL_MAX ? [small, smallSize] : [main, mainSize];
      return [size, toBytes(downsample(source, n, n, n / size))];
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

/**
 * Copies the icon set into `directory`, rendering it only when the cache has no
 * set for the current sources. Returns whether it rendered.
 */
export async function writeIcons(
  directory,
  {
    cacheRoot = join(here, "../../node_modules/.cache/foom-icons"),
    generate = () => iconFiles(iconImages()),
  } = {},
) {
  const cache = join(cacheRoot, await sourceKey());
  const rendered = !existsSync(cache);
  if (rendered) {
    const staging = `${cache}.${process.pid}.tmp`;
    await rm(staging, { recursive: true, force: true });
    try {
      await mkdir(staging, { recursive: true });
      for (const [name, data] of generate()) await writeFile(join(staging, name), data);
      await rename(staging, cache);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      // A concurrent build may have published the same set first.
      if (!existsSync(cache)) throw error;
    }
  }
  await mkdir(directory, { recursive: true });
  await cp(cache, directory, { recursive: true });
  return rendered;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: node scripts/icon/foom-icon.mjs <directory>");
  await mkdir(directory, { recursive: true });
  for (const [name, data] of iconFiles(iconImages())) await writeFile(join(directory, name), data);
}
