// Schwarzschild black hole with a thin accretion disk, traced along null geodesics.
// Units: G = c = M = 1, so the horizon is r = 2, the photon sphere r = 3 and the
// critical impact parameter (shadow edge) b = 3√3 ≈ 5.196. The app icon uses it
// through foom-icon.mjs; other art (animation frames, the About view) can import
// renderBlackHole() for linear light and the lens map, then tone-map as needed.
import { blur } from "./png.mjs";

/** Critical impact parameter: the shadow's radius in M as seen from far away. */
export const SHADOW_RADIUS = 3 * Math.sqrt(3);
const BC = SHADOW_RADIUS;

/**
 * Photon orbits in their own plane obey u'' + u = 3u² (u = 1/r, φ the in-plane
 * angle from the observer direction). A ray arriving with impact parameter b
 * starts at u = 0, du/dφ = 1/b. The table stores u(φ) per b on a regular grid.
 */
function geodesicTable({ bMax, nb, dphi, phiMax }) {
  const steps = Math.ceil(phiMax / dphi);
  const u = new Float32Array(nb * (steps + 1)),
    end = new Float32Array(nb),
    captured = new Uint8Array(nb);
  const h = dphi / 8; // RK4 sub-steps per stored sample
  for (let j = 0; j < nb; j++) {
    const b = (j / (nb - 1)) * bMax;
    let x = 0,
      v = b > 0 ? 1 / b : 1e9,
      phi = 0,
      done = false;
    const acc = (x) => -x + 3 * x * x;
    u[j * (steps + 1)] = 0;
    for (let s = 1; s <= steps && !done; s++) {
      for (let k = 0; k < 8; k++) {
        const k1x = v,
          k1v = acc(x);
        const k2x = v + (h / 2) * k1v,
          k2v = acc(x + (h / 2) * k1x);
        const k3x = v + (h / 2) * k2v,
          k3v = acc(x + (h / 2) * k2x);
        const k4x = v + h * k3v,
          k4v = acc(x + h * k3x);
        x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
        v += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
        phi += h;
        if (x >= 0.5) {
          captured[j] = 1;
          done = true;
          break;
        }
        if (x <= 0 && phi > 0.1) {
          done = true;
          break;
        }
      }
      u[j * (steps + 1) + s] = Math.max(0, Math.min(0.5, x));
      end[j] = phi;
    }
    if (!done) {
      captured[j] = 1; // still orbiting at phiMax: treat as captured
      end[j] = phiMax;
    }
  }
  return { u, end, captured, steps, bMax, nb, dphi };
}

function sampleU(T, b, phi) {
  const fb = (b / T.bMax) * (T.nb - 1),
    j = Math.min(T.nb - 2, Math.floor(fb)),
    tb = fb - j;
  const fp = phi / T.dphi,
    s = Math.min(T.steps - 1, Math.floor(fp)),
    tp = fp - s;
  const row = (jj) => {
    const o = jj * (T.steps + 1);
    return T.u[o + s] * (1 - tp) + T.u[o + s + 1] * tp;
  };
  return row(j) * (1 - tb) + row(j + 1) * tb;
}
function sampleEnd(T, b) {
  const fb = (b / T.bMax) * (T.nb - 1),
    j = Math.min(T.nb - 2, Math.floor(fb)),
    tb = fb - j;
  // Near the critical b the neighbours can disagree (one captured, one escaping).
  if (T.captured[j] !== T.captured[j + 1])
    return { end: T.end[tb < 0.5 ? j : j + 1], captured: T.captured[tb < 0.5 ? j : j + 1] };
  return { end: T.end[j] * (1 - tb) + T.end[j + 1] * tb, captured: T.captured[j] };
}

const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
// Cheap deterministic value noise for disk streaks.
const hash = (n) => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};
const noise1 = (x) => {
  const i = Math.floor(x),
    f = x - i,
    t = f * f * (3 - 2 * f);
  return hash(i) * (1 - t) + hash(i + 1) * t;
};

/**
 * Renders linear disk light into Float32Arrays.
 * opts: width, height, fov (half-width of the view in M), centerX/centerY (in M
 * offsets), inclination (degrees from the disk normal; 90 = edge-on), rIn, rOut,
 * beaming (exponent on the redshift factor g), falloff (radial emissivity power),
 * edge (outer fade start as a fraction of rOut), secondaryReach (radial reach of
 * n ≥ 1 images in units of rIn; 0 keeps the physical disk), texture (0..1 streak
 * strength), maxOrder (disk crossings to accumulate), opacity per crossing,
 * supersample (rays per pixel side), ringStrength/ringWidth (photon ring), roll
 * (camera roll in degrees, canvas convention: negative tilts the disk up to the
 * right) and skyDistance (distance in M of the background plane for the lens map).
 * Returns { light, temp, shadow, lens }: light intensity, a 0..1 "heat"
 * (g-weighted) for colour, 1 where the ray falls into the hole, and the lens map.
 * lens holds two floats per pixel: where the pixel's ray meets a background plane
 * skyDistance behind the hole, in screen-aligned M (x right, y up). Captured rays,
 * and rays bent by 80° or more, are NaN; a caller can paint those black or sample
 * an environment map. Without the hole, lens[x, y] would equal the pixel's own
 * screen position, so a starfield drawn in that plane and shifted over time shows
 * correct lensing.
 */
export function renderBlackHole(opts) {
  const {
    width: W,
    height: H,
    fov = 16,
    centerX = 0,
    centerY = 0,
    inclination = 84,
    rIn = 6,
    rOut = 18,
    beaming = 3,
    texture = 0.35,
    maxOrder = 4,
    opacity = 0.85,
    supersample = 1,
    ringStrength = 0,
    ringWidth = 0.08,
    falloff = 2.2,
    edge = 0.7,
    secondaryReach = 0,
    roll = 0,
    skyDistance = 3 * fov,
  } = opts;
  const rc = Math.cos((roll * Math.PI) / 180),
    rs = -Math.sin((roll * Math.PI) / 180);
  const T = geodesicTable({ bMax: fov * 1.6, nb: 8000, dphi: 0.01, phiMax: 4 * Math.PI });
  const th = (inclination * Math.PI) / 180,
    st = Math.sin(th),
    ct = Math.cos(th);
  const o = [0, -st, ct],
    ex = [1, 0, 0],
    ey = [0, ct, st];
  const light = new Float32Array(W * H),
    temp = new Float32Array(W * H),
    shadow = new Float32Array(W * H),
    lens = new Float32Array(W * H * 2);
  const scale = (2 * fov) / W;
  const ss = supersample;
  for (let py = 0; py < H; py++)
    for (let px = 0; px < W; px++) {
      let L = 0,
        Tg = 0,
        S = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          // Screen position (x right, y up), then undo the camera roll to get the
          // disk-aligned image-plane coordinates (a, bb).
          const qx = (px + (sx + 0.5) / ss - W / 2) * scale + centerX,
            qy = -(py + (sy + 0.5) / ss - H / 2) * scale + centerY;
          const a = qx * rc + qy * rs,
            bb = -qx * rs + qy * rc;
          const b = Math.hypot(a, bb);
          const cx = b > 0 ? a / b : 1,
            cy = b > 0 ? bb / b : 0;
          const e = [cx * ex[0] + cy * ey[0], cx * ex[1] + cy * ey[1], cx * ex[2] + cy * ey[2]];
          const { end, captured } = sampleEnd(T, b);
          // Equatorial crossings: cos φ o_z + sin φ e_z = 0.
          let phi0 = Math.abs(e[2]) < 1e-9 ? Math.PI / 2 : Math.atan(-o[2] / e[2]);
          if (phi0 <= 0) phi0 += Math.PI;
          let trans = 1,
            l = 0,
            tg = 0;
          for (let n = 0; n < maxOrder; n++) {
            const phi = phi0 + n * Math.PI;
            if (phi >= end) break;
            const uu = sampleU(T, b, phi);
            if (uu <= 0) continue;
            const r = 1 / uu;
            if (r < rIn - 0.6 || r > rOut) continue;
            const x = r * (Math.cos(phi) * o[0] + Math.sin(phi) * e[0]),
              y = r * (Math.cos(phi) * o[1] + Math.sin(phi) * e[1]);
            const psi = Math.atan2(y, x);
            // Redshift for circular Keplerian orbits; λ = L_z/E = -α sin i.
            const Om = Math.pow(r, -1.5),
              lam = -a * st;
            const g = Math.sqrt(Math.max(0.0001, 1 - 3 / r)) / (1 - Om * lam);
            let em =
              smooth(rIn - 0.6, rIn + 1.2, r) *
              Math.pow(rIn / r, falloff) *
              (1 - smooth(rOut * edge, rOut, r));
            if (texture) {
              const streak =
                noise1(r * 2.3 + 7 * noise1(psi * 1.3 + r * 0.15)) * 0.6 + noise1(r * 7.1) * 0.4;
              em *= 1 - texture + texture * 1.6 * streak;
            }
            // Art direction: let higher-order images keep only the inner disk, so the
            // arch under the shadow stays a thin bright crescent.
            if (n > 0 && secondaryReach)
              em *= 1 - smooth(rIn * 1.15, rIn * (1.15 + secondaryReach), r);
            const I = em * Math.pow(g, beaming);
            l += trans * I;
            tg += trans * I * g;
            trans *=
              1 - opacity * smooth(rIn - 0.6, rIn + 0.6, r) * (1 - smooth(rOut * 0.8, rOut, r));
          }
          if (ringStrength) {
            // Photon ring: the n ≥ 2 images pile up just outside b = 3√3. A thin
            // disk resolves them as hairlines, so lay down their summed light.
            const ring =
              ringStrength *
              Math.exp(-(((b - BC - ringWidth * 0.5) / ringWidth) ** 2)) *
              (1 - 0.3 * (b > 0 ? a / b : 0));
            l += ring;
            tg += ring * 1.5;
          }
          L += l;
          Tg += l > 0 ? tg / l : 0;
          S += captured ? 1 : 0;
          if (sx === 0 && sy === 0) {
            // Escaped rays leave bent by δ = φ_end − π toward the hole; follow them
            // to the background plane. The bend is radial, so it is roll-invariant.
            const k2 = (py * W + px) * 2,
              delta = end - Math.PI;
            if (captured || delta >= (80 * Math.PI) / 180 || b === 0) {
              lens[k2] = lens[k2 + 1] = Number.NaN;
            } else {
              const reach = (b - skyDistance * Math.tan(delta)) / b;
              lens[k2] = qx * reach;
              lens[k2 + 1] = qy * reach;
            }
          }
        }
      const n = ss * ss,
        k = py * W + px;
      light[k] = L / n;
      temp[k] = Tg / n;
      shadow[k] = S / n;
    }
  return { light, temp, shadow, lens, width: W, height: H };
}

/** Parses `#RRGGBB` into 0..1 channels. */
export const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
/** Brand ramp: deep violet → accent → lilac → white. */
export const BRAND_RAMP = [
  [0, "#000000"],
  [0.18, "#2A0F7A"],
  [0.42, "#7A3CFF"],
  [0.62, "#9B6BFF"],
  [0.82, "#D9C8FF"],
  [1, "#FFFFFF"],
].map(([t, c]) => [t, hex(c)]);
export function ramp(v, stops = BRAND_RAMP) {
  v = Math.max(0, Math.min(1, v));
  for (let i = 1; i < stops.length; i++)
    if (v <= stops[i][0]) {
      const [t0, c0] = stops[i - 1],
        [t1, c1] = stops[i],
        t = (v - t0) / (t1 - t0);
      return [0, 1, 2].map((k) => c0[k] + (c1[k] - c0[k]) * t);
    }
  return stops[stops.length - 1][1];
}

/**
 * Tone-maps a render, with bloom computed at reduced resolution. With a
 * `background(u, v) → [r, g, b]` it returns opaque RGBA composited over it.
 * Without one it returns premultiplied RGBA for layering: rgb is the disk's
 * emitted light (plus the hole colour where captured) and alpha is the shadow's
 * coverage, so `out = rgb + behind · (1 − alpha)` composites it over any sky.
 */
export function toneMap(
  render,
  { exposure = 2.2, heat = 0.35, bloom = 0.55, bloomSigma = 0.035, background, hole = "#06050B" },
) {
  const { light, temp, shadow, width: W, height: H } = render;
  const f = 4,
    w = W / f,
    h = H / f,
    small = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let j = 0; j < f; j++)
        for (let i = 0; i < f; i++)
          s += 1 - Math.exp(-exposure * light[(y * f + j) * W + x * f + i]);
      small[y * w + x] = s / (f * f);
    }
  const glow = blur(small, w, h, bloomSigma * w);
  const holeC = hex(hole);
  const out = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      // Bilinear bloom lookup.
      const gx = Math.min(w - 1.001, Math.max(0, x / f - 0.5)),
        gy = Math.min(h - 1.001, Math.max(0, y / f - 0.5)),
        ix = Math.floor(gx),
        iy = Math.floor(gy),
        tx = gx - ix,
        ty = gy - iy;
      const gl =
        glow[iy * w + ix] * (1 - tx) * (1 - ty) +
        glow[iy * w + ix + 1] * tx * (1 - ty) +
        glow[(iy + 1) * w + ix] * (1 - tx) * ty +
        glow[(iy + 1) * w + ix + 1] * tx * ty;
      const bg = background ? background(x / W, y / H) : [0, 0, 0];
      const base = bg.map((c, i) => c * (1 - shadow[k]) + holeC[i] * shadow[k]);
      const v = 1 - Math.exp(-exposure * light[k]);
      // Hotter (blue-shifted) light climbs further up the ramp toward white.
      const tv = Math.min(1, v * (1 - heat + heat * Math.min(1.6, temp[k])));
      const col = ramp(tv);
      const gcol = ramp(Math.min(0.7, gl * 0.9));
      for (let i = 0; i < 3; i++) {
        let c = 1 - (1 - base[i]) * (1 - col[i]);
        c = 1 - (1 - c) * (1 - gcol[i] * bloom);
        out[k * 4 + i] = c;
      }
      out[k * 4 + 3] = background ? 1 : shadow[k];
    }
  return out;
}

/**
 * Converts premultiplied light to straight alpha for PNG/canvas source-over.
 * Bright emission becomes partly opaque (alpha = max(coverage, brightest
 * channel)); that is exact for a black sky and a good approximation otherwise.
 */
export function toStraightAlpha(pre) {
  const out = new Float32Array(pre.length);
  for (let k = 0; k < pre.length; k += 4) {
    const a = Math.min(1, Math.max(pre[k + 3], pre[k], pre[k + 1], pre[k + 2]));
    out[k + 3] = a;
    if (a > 0) for (let i = 0; i < 3; i++) out[k + i] = Math.min(1, pre[k + i] / a);
  }
  return out;
}
