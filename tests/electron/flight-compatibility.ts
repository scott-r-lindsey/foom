import { createFlightArt, type Palette } from "../../src/renderer/ui/flight-art";
import { createSingularity, LENS_RADIUS } from "../../src/renderer/ui/singularity";
import { createMainStarfield } from "./flight-main";

/** Real accelerated-canvas comparison, run inside an isolated renderer bundle. */
export async function compare() {
  const canvas = document.createElement("canvas");
  const reference = document.createElement("canvas");
  canvas.width = reference.width = 900;
  canvas.height = reference.height = 600;
  const ctx = canvas.getContext("2d", { willReadFrequently: true }),
    baseline = reference.getContext("2d", { willReadFrequently: true });
  if (!ctx || !baseline) throw new Error("Missing canvas");
  let loaded = 0;
  let resolve = () => {};
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  const lens = createSingularity(() => {
    if (++loaded === 3) resolve();
  });
  const original = createMainStarfield();
  let outside = 0,
    beforeDelta = 0,
    outsideDelta = 0,
    insideChanges = 0;
  const palette: Palette = {
    mode: "dark",
    star: "#F4EFFF",
    accent: "#9B6BFF",
    deep: "#7A3CFF",
    hot: "#F4EFFF",
    cool: "#7A3CFF",
    hull: "#F4EFFF",
    outline: "transparent",
    hole: "#06050B",
  };
  const art = createFlightArt({
    draw(context, w, h, x, y, radius, time, dark) {
      const before = context.getImageData(0, 0, w, h).data;
      const main = baseline.getImageData(0, 0, w, h).data;
      lens.draw(context, w, h, x, y, radius, time, dark);
      const after = context.getImageData(0, 0, w, h).data;
      for (let row = 0; row < h; row++)
        for (let col = 0; col < w; col++) {
          const k = (row * w + col) * 4;
          const far = Math.hypot(col - x, row - y) > radius * (LENS_RADIUS + 0.1);
          if (far) outside++;
          for (let c = 0; c < 4; c++) {
            const premult = (data: Uint8ClampedArray) =>
              c === 3 ? (data[k + c] ?? 0) : ((data[k + c] ?? 0) * (data[k + 3] ?? 0)) / 255;
            beforeDelta = Math.max(beforeDelta, Math.abs(premult(before) - premult(main)));
            const delta = Math.abs(premult(after) - premult(before));
            if (far) outsideDelta = Math.max(outsideDelta, delta);
            else if (delta > 5) insideChanges++;
          }
        }
    },
    dispose() {},
  });
  try {
    await ready;
    // Put both 2D canvases through the same GPU-image transfer before comparing
    // their small antialiased stars. Chromium changes its raster backend after
    // the first WebGL image, independently of the procedural drawing commands.
    lens.draw(ctx, 900, 600, 450, 300, 50, 0, true);
    lens.draw(baseline, 900, 600, 450, 300, 50, 0, true);
    for (const launch of [true, false])
      for (const mode of ["dark", "light"]) {
        const p = { ...palette, mode, star: mode === "light" ? "#14101F" : palette.star };
        for (const time of [0, 1400, 2500, 3400, 8000]) {
          canvas.width = reference.width = 900;
          original(baseline, 900, 600, time, p, launch, false);
          art(ctx, 900, 600, time, p, launch, false);
        }
      }
    // A point in the ORIGINAL canvas is the only source for its lensed images.
    const readLobes = () =>
      [-1, 1].map((side) => {
        const data = ctx.getImageData(448, Math.round(300 + side * 50 * 1.97) - 2, 5, 5).data;
        return Math.max(...data.filter((_v, i) => i % 4 === 3));
      });
    ctx.clearRect(0, 0, 900, 600);
    lens.draw(ctx, 900, 600, 450, 300, 50, 0, true);
    const empty = readLobes();
    ctx.clearRect(0, 0, 900, 600);
    ctx.fillStyle = "#F4EFFF";
    ctx.fillRect(449, 299, 2, 2);
    lens.draw(ctx, 900, 600, 450, 300, 50, 0, true);
    const lobes = readLobes().map((value, i) => value - (empty[i] ?? 0));
    const shadow = Array.from(ctx.getImageData(450, 285, 1, 1).data);
    // A continuous ramp exposes any discontinuity where the rectangular baked
    // lookup ends (14 M, or 2.694 shadow radii), inside the circular composite.
    ctx.clearRect(0, 0, 900, 600);
    const ramp = ctx.createLinearGradient(450, 0, 600, 0);
    ramp.addColorStop(0, "#000000");
    ramp.addColorStop(1, "#F4EFFF");
    ctx.fillStyle = ramp;
    ctx.fillRect(0, 0, 900, 600);
    lens.draw(ctx, 900, 600, 450, 300, 50, 0, true);
    const boundary = ctx.getImageData(582, 300, 8, 1).data;
    let boundaryJump = 0;
    for (let k = 5; k < boundary.length; k += 4)
      boundaryJump = Math.max(boundaryJump, Math.abs((boundary[k] ?? 0) - (boundary[k - 4] ?? 0)));
    return { outside, beforeDelta, outsideDelta, insideChanges, lobes, shadow, boundaryJump };
  } finally {
    lens.dispose();
  }
}
