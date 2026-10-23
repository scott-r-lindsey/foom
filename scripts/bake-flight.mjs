// Reproducible R3 flight assets. No renderer code traces rays.
// node scripts/bake-flight.mjs [destination]
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderBlackHole, SHADOW_RADIUS, toneMap, toStraightAlpha } from "./icon/blackhole.mjs";
import { VIEW, TONE } from "./icon/foom-icon.mjs";
import { encodePng, toBytes, toDitheredBytes } from "./icon/png.mjs";

const directory = resolve(process.argv[2] || "src/renderer/art");
await mkdir(directory, { recursive: true });
const size = 512;
// The icon's centre offset is a tile composition choice. Centre the shadow on
// the flight geometry while retaining its exact camera and disk parameters.
const view = { ...VIEW, centerY: 0, width: size, height: size, supersample: 2, skyDistance: 16 };
const render = renderBlackHole(view);
const light = toneMap(render, TONE);
await writeFile(
  `${directory}/singularity.png`,
  encodePng(toDitheredBytes(toStraightAlpha(light), size), size, size),
);
// RGB stores emitted light; opaque alpha avoids PNG's transparent RGB loss in
// browser image decoding. Shadow coverage is stored in the map's blue channel.
const emission = light.slice();
for (let k = 3; k < emission.length; k += 4) emission[k] = 1;
await writeFile(
  `${directory}/emission.png`,
  encodePng(toDitheredBytes(emission, size), size, size),
);
// Each half holds one signed coordinate in two bytes, ±256 M. Blue is escape
// visibility on the x half, actual shadow coverage on the y half; alpha is opaque.
const map = new Uint8Array(size * size * 8);
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const k = y * size + x;
    for (let axis = 0; axis < 2; axis++) {
      const value = render.lens[k * 2 + axis];
      const valid = Number.isFinite(value);
      const q = Math.round(
        ((Math.max(-256, Math.min(256, valid ? value : 0)) + 256) / 512) * 65535,
      );
      const o = (y * size * 2 + x + axis * size) * 4;
      const coverage = axis === 0 ? (valid ? 1 - render.shadow[k] : 0) : render.shadow[k];
      map.set([q >> 8, q & 255, Math.round(coverage * 255), 255], o);
    }
  }
await writeFile(`${directory}/lens.png`, encodePng(map, size * 2, size));
// A repeating sky plane, sampled once per fragment. Gaussian stars resolve into
// arcs and secondary images without generating particles in a fragment shader.
const skySize = 1024;
const sky = new Float32Array(skySize * skySize * 4);
let seed = 725;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function star(x, y, brightness, radius) {
  for (let dy = -5; dy <= 5; dy++)
    for (let dx = -5; dx <= 5; dx++) {
      const px = Math.floor(x) + dx,
        py = Math.floor(y) + dy;
      const k = (((py + skySize) % skySize) * skySize + ((px + skySize) % skySize)) * 4;
      const v = brightness * Math.exp(-((px - x) ** 2 + (py - y) ** 2) / (radius * radius));
      sky[k] = Math.min(1, sky[k] + v * 0.956);
      sky[k + 1] = Math.min(1, sky[k + 1] + v * 0.937);
      sky[k + 2] = Math.min(1, sky[k + 2] + v);
    }
}
for (let i = 0; i < 1200; i++)
  star(
    Math.floor(random() * skySize),
    Math.floor(random() * skySize),
    0.3 + random() * 0.7,
    0.7 + random() * 0.65,
  );
// This bright star crosses the optical axis at eight seconds, so each launch
// exposes an Einstein ring rather than relying on a chance close passage.
star(0.032 * skySize - 0.5, 0.17 * skySize - 0.5, 1, 2.2);
for (let k = 3; k < sky.length; k += 4) sky[k] = 1;
await writeFile(`${directory}/sky.png`, encodePng(toBytes(sky), skySize, skySize));
console.log(
  JSON.stringify({ size, fov: VIEW.fov, shadowRadius: SHADOW_RADIUS, view: VIEW, tone: TONE }),
);
