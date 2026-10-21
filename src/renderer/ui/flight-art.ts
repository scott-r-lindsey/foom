const TAU = Math.PI * 2;

export interface Palette {
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
type Point = [number, number];
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
const mix = (a: string, b: string, t: number, alpha: number) => {
  const x = hex(a),
    y = hex(b);
  return `rgba(${x.map((v, i) => Math.round(v + ((y[i] ?? 0) - v) * t)).join(",")},${String(alpha)})`;
};
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
/** Black hole with photon ring and accretion disk; `flare` brightens the ring. */
function hole(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  R: number,
  P: Palette,
  t: number,
  flare = 0,
  tilt = -0.12,
) {
  const dark = P.mode === "dark";
  let g = ctx.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 4.2);
  g.addColorStop(0, rgba(P.deep, (dark ? 0.42 : 0.2) + flare * 0.3));
  g.addColorStop(1, rgba(P.deep, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 4.2, 0, TAU);
  ctx.fill();
  const shimmer = (i: number) => 0.85 + 0.15 * Math.sin(t / 700 + i * 0.7);
  const disk = (a0: number, a1: number) => {
    for (let i = 0; i < 18; i++) {
      const k = i / 17;
      ctx.strokeStyle = mix(P.hot, P.cool, k, (0.8 - k * 0.6) * shimmer(i));
      ctx.lineWidth = Math.max(0.6, R * 0.03);
      ctx.beginPath();
      ctx.ellipse(cx, cy, R * (1.5 + k * 1.5), R * (0.2 + k * 0.22), tilt, a0, a1);
      ctx.stroke();
    }
  };
  disk(Math.PI, TAU);
  g = ctx.createRadialGradient(cx, cy, R, cx, cy, R * (1.5 + flare * 0.6));
  g.addColorStop(0, dark ? rgba(P.star, 0.95) : rgba(P.deep, 0.95));
  g.addColorStop(0.2, rgba(P.accent, 0.85));
  g.addColorStop(1, rgba(P.accent, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, R * (1.5 + flare * 0.6), 0, TAU);
  ctx.fill();
  ctx.fillStyle = P.hole;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = dark ? rgba(P.star, 0.95) : P.accent;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 1.02, 0, TAU);
  ctx.stroke();
  disk(0, Math.PI);
}

/** Rocket pointing up at angle `rot` (0 = up). `s` is its length in px; `burn` 0..1. */
function rocket(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rot: number,
  s: number,
  burn: number,
  t: number,
  P: Palette,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(s, s);
  if (burn > 0) {
    const L = (0.18 + 0.5 * burn) * (1 + 0.1 * Math.sin(t / 32) + 0.06 * Math.sin(t / 13));
    ctx.shadowColor = P.deep;
    ctx.shadowBlur = 18 * burn;
    let g = ctx.createLinearGradient(0, 0.33, 0, 0.33 + L);
    g.addColorStop(0, P.hull);
    g.addColorStop(0.3, rgba(P.accent, 0.95));
    g.addColorStop(1, rgba(P.deep, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-0.085, 0.33);
    ctx.quadraticCurveTo(-0.07, 0.33 + L * 0.55, 0, 0.33 + L);
    ctx.quadraticCurveTo(0.07, 0.33 + L * 0.55, 0.085, 0.33);
    ctx.fill();
    ctx.shadowBlur = 0;
    g = ctx.createLinearGradient(0, 0.33, 0, 0.33 + L * 0.5);
    g.addColorStop(0, P.hull);
    g.addColorStop(1, rgba(P.hull, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-0.04, 0.33);
    ctx.quadraticCurveTo(-0.03, 0.33 + L * 0.3, 0, 0.33 + L * 0.5);
    ctx.quadraticCurveTo(0.03, 0.33 + L * 0.3, 0.04, 0.33);
    ctx.fill();
  }
  ctx.lineJoin = "round";
  ctx.lineWidth = 0.022;
  ctx.strokeStyle = P.outline;
  // fins
  ctx.fillStyle = P.accent;
  ctx.beginPath();
  ctx.moveTo(-0.13, 0.06);
  ctx.lineTo(-0.29, 0.33);
  ctx.lineTo(-0.13, 0.27);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0.13, 0.06);
  ctx.lineTo(0.29, 0.33);
  ctx.lineTo(0.13, 0.27);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // nozzle
  ctx.fillStyle = P.deep;
  ctx.beginPath();
  ctx.moveTo(-0.075, 0.27);
  ctx.lineTo(0.075, 0.27);
  ctx.lineTo(0.095, 0.34);
  ctx.lineTo(-0.095, 0.34);
  ctx.closePath();
  ctx.fill();
  // hull
  ctx.fillStyle = P.hull;
  ctx.beginPath();
  ctx.moveTo(0, -0.52);
  ctx.bezierCurveTo(0.17, -0.33, 0.16, -0.02, 0.14, 0.29);
  ctx.lineTo(-0.14, 0.29);
  ctx.bezierCurveTo(-0.16, -0.02, -0.17, -0.33, 0, -0.52);
  ctx.fill();
  ctx.stroke();
  // nose band and center fin
  ctx.fillStyle = P.accent;
  ctx.beginPath();
  ctx.moveTo(0, -0.52);
  ctx.bezierCurveTo(0.07, -0.45, 0.1, -0.4, 0.115, -0.34);
  ctx.lineTo(-0.115, -0.34);
  ctx.bezierCurveTo(-0.1, -0.4, -0.07, -0.45, 0, -0.52);
  ctx.fill();
  ctx.fillRect(-0.018, 0.1, 0.036, 0.19);
  // window
  ctx.fillStyle = P.hole;
  ctx.beginPath();
  ctx.arc(0, -0.13, 0.062, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 0.028;
  ctx.stroke();
  ctx.restore();
}

function curve(k: number, x0: number, y0: number, x1: number, y1: number, n = 260): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n,
      f = (Math.exp(k * t) - 1) / (Math.exp(k) - 1);
    pts.push([x0 + (x1 - x0) * t, y0 - (y0 - y1) * f]);
  }
  return pts;
}
const along = (pts: Point[], u: number): [number, number, number] => {
  const f = clamp(u) * (pts.length - 1),
    i = Math.min(pts.length - 2, Math.floor(f)),
    r = f - i;
  const a = pts[i] ?? [0, 0],
    b = pts[i + 1] ?? a;
  return [
    a[0] + (b[0] - a[0]) * r,
    a[1] + (b[1] - a[1]) * r,
    Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2,
  ];
};
function trail(ctx: CanvasRenderingContext2D, pts: Point[], upto: number, P: Palette, width = 2.4) {
  const n = Math.max(2, Math.floor(clamp(upto) * (pts.length - 1)));
  const g = ctx.createLinearGradient(pts[0]?.[0] ?? 0, 0, (pts[n]?.[0] ?? 0) + 1, 0);
  g.addColorStop(0, rgba(P.accent, 0.12));
  g.addColorStop(0.7, rgba(P.accent, 0.9));
  g.addColorStop(1, P.mode === "dark" ? P.star : P.deep);
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = g;
  ctx.lineWidth = width;
  if (P.mode === "dark") {
    ctx.shadowColor = P.deep;
    ctx.shadowBlur = 14;
  }
  ctx.beginPath();
  for (const [i, point] of pts.entries()) {
    if (i > n) break;
    if (i) ctx.lineTo(...point);
    else ctx.moveTo(...point);
  }
  ctx.stroke();
  ctx.restore();
}
function puffs(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  t0: number,
  t: number,
  spread: number,
  P: Palette,
) {
  for (let i = 0; i < 14; i++) {
    const age = (t - t0 - i * 55) / 1400;
    if (age < 0 || age > 1) continue;
    const dir = (i % 2 ? 1 : -1) * (0.4 + ((i * 37) % 10) / 14);
    ctx.fillStyle = rgba(P.star, 0.22 * (1 - age));
    ctx.beginPath();
    ctx.arc(x + dir * spread * age, y - 4 * age + (i % 3) * 2, 4 + 18 * age, 0, TAU);
    ctx.fill();
  }
}

/** One drawing state per mounted canvas, never shared between dialogs. */
export function createFlightArt() {
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
      const cx = w * 0.62,
        cy = h * 0.4,
        R = Math.min(w, h) * 0.085;
      const pts = curve(5.6, w * 0.1, h * 0.84, w * 0.86, -h * 0.08);
      const u = clamp((t - 2100) / 1800),
        p = still ? 1 : Math.pow(u, 1.7);
      const dt = still ? 0 : clamp((t - last) / 1000, 0, 0.05);
      last = t;
      warp(
        ctx,
        w,
        h,
        depth,
        cx,
        cy,
        still ? 0.12 : 0.05 + 1.1 * ease(clamp((t - 2100) / 1600)),
        dt,
        P,
      );
      hole(ctx, cx, cy, R, P, still ? 0 : t);
      ctx.strokeStyle = rgba(P.star, 0.18);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w * 0.05, h * 0.84 + 9);
      ctx.lineTo(w * 0.2, h * 0.84 + 9);
      ctx.stroke();
      if (!still && t > 1400 && t < 3000) puffs(ctx, w * 0.1 - 10, h * 0.84 + 4, 1400, t, 40, P);
      if (p > 0) trail(ctx, pts, p, P);
      if (p < 1 || still) {
        const [x, y, a] = along(pts, still ? 0.93 : p);
        rocket(
          ctx,
          x + Math.sin(a) * 10,
          y - Math.cos(a) * 10,
          a,
          Math.min(w, h) * 0.085,
          still ? 1 : t < 1400 ? 0 : t < 2100 ? 0.35 : 0.6 + 0.4 * u,
          still ? 0 : t,
          P,
        );
      }
    } else {
      const time = still ? 0 : t;
      stars(ctx, w, h, field, P, time);
      const R = h * 0.11,
        cx = w * 0.66,
        cy = h * 0.36;
      hole(ctx, cx, cy, R, P, time);
      const pts = curve(5.4, w * 0.04, h * 0.62, cx + R * 2.3, h * 0.06);
      trail(ctx, pts, 0.94, P);
      const [x, y, a] = along(pts, 0.94),
        size = h * 0.12;
      rocket(
        ctx,
        x + Math.sin(a) * size * 0.35,
        y - Math.cos(a) * size * 0.35 + Math.sin(time / 600) * 1.5,
        a,
        size,
        0.8,
        time,
        P,
      );
    }
  };
}
