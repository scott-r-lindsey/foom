// Frozen main (e095040d) procedural sky for pixel compatibility regression.
const TAU = Math.PI * 2;

interface Palette {
  mode: string;
  star: string;
  accent: string;
  deep: string;
  hot: string;
  cool: string;
  hull: string;
  outline: string;
  hole: string;
}
interface Star {
  x: number;
  y: number;
  z: number;
  p: number;
}
interface Depth {
  x: number;
  y: number;
  z: number;
}
const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const rgba = (c: string, a: number) => `rgba(${hex(c).join(",")},${String(a)})`;
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const ease = (u: number) => u * u * (3 - 2 * u);
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

const makeStars = (n: number) =>
  Array.from({ length: n }, () => ({ x: rnd(), y: rnd(), z: rnd() * 0.8 + 0.2, p: rnd() * TAU }));
function stars(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  list: Star[],
  P: Palette,
  t: number,
  streak = 0,
  dx = 0,
) {
  ctx.fillStyle = P.star;
  for (const s of list) {
    const tw = 0.75 + 0.25 * Math.sin(t / 900 + s.p);
    ctx.globalAlpha = (P.mode === "dark" ? 0.25 + s.z * 0.6 : 0.06 + s.z * 0.14) * tw;
    const len = 1 + streak * s.z;
    ctx.fillRect(s.x * w, s.y * h, 1.1 * s.z + 0.3 + Math.abs(dx) * s.z, len);
  }
  ctx.globalAlpha = 1;
}
/** Stars in depth, flying out of the vanishing point (vx, vy) toward the viewer. */
const makeDeep = (n: number) =>
  Array.from({ length: n }, () => ({ x: rnd() * 2 - 1, y: rnd() * 2 - 1, z: rnd() * 0.95 + 0.05 }));
function warp(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  list: Depth[],
  vx: number,
  vy: number,
  speed: number,
  dt: number,
  P: Palette,
) {
  const f = Math.max(w, h) * 0.45,
    stretch = Math.min(0.12, speed * 0.045);
  ctx.lineCap = "round";
  for (const s of list) {
    s.z -= speed * dt;
    const px = vx + (s.x / s.z) * f,
      py = vy + (s.y / s.z) * f;
    if (s.z <= 0.02 || px < -40 || px > w + 40 || py < -40 || py > h + 40) {
      s.x = rnd() * 2 - 1;
      s.y = rnd() * 2 - 1;
      s.z = 0.9 + rnd() * 0.1;
      continue;
    }
    const z0 = s.z + stretch,
      qx = vx + (s.x / z0) * f,
      qy = vy + (s.y / z0) * f;
    const near = 1 - s.z;
    ctx.strokeStyle = rgba(P.star, Math.min(1, 0.15 + near * 0.95));
    ctx.lineWidth = 0.5 + near * 1.8;
    ctx.beginPath();
    ctx.moveTo(qx, qy);
    ctx.lineTo(px + 0.01, py + 0.01);
    ctx.stroke();
  }
}
export function createMainStarfield() {
  const field = makeStars(110),
    depth = makeDeep(190);
  let last = 0;
  return (
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    t: number,
    P: Palette,
    launch: boolean,
    still: boolean,
  ) => {
    ctx.clearRect(0, 0, w, h);
    if (launch) {
      const dt = still ? 0 : clamp((t - last) / 1000, 0, 0.05);
      last = t;
      warp(
        ctx,
        w,
        h,
        depth,
        w * 0.62,
        h * 0.4,
        still ? 0.12 : 0.05 + 1.1 * ease(clamp((t - 2100) / 1600)),
        dt,
        P,
      );
    } else stars(ctx, w, h, field, P, still ? 0 : t);
  };
}
