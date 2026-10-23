// Minimal RGBA PNG encoder and float-image helpers (Node built-ins only).
import { deflateSync } from "node:zlib";

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Quantizes straight-alpha float RGBA (0..1, four values per pixel) to bytes. */
export function toBytes(rgba) {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i++)
    out[i] = Math.max(0, Math.min(255, Math.round(rgba[i] * 255)));
  return out;
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * Quantizes like toBytes, with a 4x4 Bayer ordered dither of ±½ step on colour
 * (not alpha). It breaks up banding in smooth gradients such as the disk glow.
 */
export function toDitheredBytes(rgba, width) {
  const out = new Uint8Array(rgba.length);
  for (let k = 0; k < rgba.length; k++) {
    const pixel = k >> 2;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const offset = (k & 3) === 3 ? 0 : (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5;
    out[k] = Math.max(0, Math.min(255, Math.round(rgba[k] * 255 + offset)));
  }
  return out;
}

/** Encodes 8-bit straight-alpha RGBA as a PNG. */
export function encodePng(bytes, width, height) {
  if (bytes.length !== width * height * 4) throw new Error("PNG pixel data does not match size");
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(bytes.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Box-downsamples float RGBA by an integer factor, weighting colour by alpha. */
export function downsample(src, width, height, factor) {
  if (!Number.isInteger(factor) || width % factor || height % factor)
    throw new Error(`Cannot downsample ${width}x${height} by ${factor}`);
  const W = width / factor;
  const H = height / factor;
  const out = new Float32Array(W * H * 4);
  const n = factor * factor;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < factor; j++)
        for (let i = 0; i < factor; i++) {
          const k = ((y * factor + j) * width + x * factor + i) * 4;
          const alpha = src[k + 3];
          r += src[k] * alpha;
          g += src[k + 1] * alpha;
          b += src[k + 2] * alpha;
          a += alpha;
        }
      const o = (y * W + x) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
      }
      out[o + 3] = a / n;
    }
  return out;
}

/** Separable Gaussian blur of a single-channel float image, clamped at the edges. */
export function blur(src, width, height, sigma) {
  const radius = Math.ceil(sigma * 3);
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    kernel[i + radius] = Math.exp((-i * i) / (2 * sigma * sigma));
    sum += kernel[i + radius];
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let i = -radius; i <= radius; i++)
        s += src[y * width + Math.min(width - 1, Math.max(0, x + i))] * kernel[i + radius];
      tmp[y * width + x] = s;
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let i = -radius; i <= radius; i++)
        s += tmp[Math.min(height - 1, Math.max(0, y + i)) * width + x] * kernel[i + radius];
      out[y * width + x] = s;
    }
  return out;
}
