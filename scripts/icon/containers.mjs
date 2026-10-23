// Platform icon containers written directly: Windows .ico and macOS .icns.

/**
 * Windows icon from 8-bit RGBA images ({ size, bytes, png }). Sizes under 256 are
 * stored as 32-bit DIBs, which every Windows shell and resource tool reads; 256 is
 * stored as PNG, the only practical encoding at that size.
 */
export function encodeIco(images) {
  const payloads = images.map(({ size, bytes, png }) => {
    if (size < 1 || size > 256) throw new Error(`Unsupported ICO size ${size}`);
    return size === 256 ? png : dib(size, bytes);
  });
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size }, i) => {
    const entry = 6 + i * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(payloads[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += payloads[i].length;
  });
  return Buffer.concat([header, ...payloads]);
}

function dib(size, bytes) {
  if (bytes.length !== size * size * 4) throw new Error("ICO pixel data does not match size");
  const maskStride = Math.ceil(size / 32) * 4;
  const out = Buffer.alloc(40 + size * size * 4 + maskStride * size);
  out.writeUInt32LE(40, 0);
  out.writeInt32LE(size, 4);
  // The height covers the colour rows and the AND mask rows.
  out.writeInt32LE(size * 2, 8);
  out.writeUInt16LE(1, 12);
  out.writeUInt16LE(32, 14);
  out.writeUInt32LE(size * size * 4 + maskStride * size, 20);
  const mask = 40 + size * size * 4;
  for (let y = 0; y < size; y++) {
    // DIB rows run bottom-up, in BGRA order.
    const row = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const k = (y * size + x) * 4;
      const o = 40 + (row * size + x) * 4;
      out[o] = bytes[k + 2];
      out[o + 1] = bytes[k + 1];
      out[o + 2] = bytes[k];
      out[o + 3] = bytes[k + 3];
      if (bytes[k + 3] === 0) out[mask + row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/** macOS icon types by pixel size and scale, all PNG-encoded. */
export const ICNS_TYPES = [
  ["icp4", 16, 1],
  ["ic11", 16, 2],
  ["icp5", 32, 1],
  ["ic12", 32, 2],
  ["ic07", 128, 1],
  ["ic13", 128, 2],
  ["ic08", 256, 1],
  ["ic14", 256, 2],
  ["ic09", 512, 1],
  ["ic10", 512, 2],
];

/** macOS icon file from [type, png] pairs. */
export function encodeIcns(entries) {
  const chunks = entries.map(([type, png]) => {
    if (!/^[a-z0-9]{4}$/.test(type)) throw new Error(`Invalid ICNS type ${type}`);
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([header, png]);
  });
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}
