import { crc32 } from "node:zlib";

export const IMAGE_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const MAX_IMAGE_PIXELS = 16_000_000;

export function imageType(body: Buffer): string | undefined {
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (body[0] === 255 && body[1] === 216 && body[2] === 255) return "image/jpeg";
  if (body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  return undefined;
}

/** Walk at most 16 MiB, advancing by at least 12 bytes per chunk. */
function staticPng(body: Buffer): boolean {
  if (body.length > 16 * 1024 * 1024) return false;
  let offset = 8;
  while (offset + 12 <= body.length) {
    const length = body.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > body.length) return false;
    const type = body.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return false;
    if (offset === 8 && (type !== "IHDR" || length !== 13)) return false;
    if (crc32(body.subarray(offset + 4, end - 4)) !== body.readUInt32BE(end - 4)) return false;
    if (type === "IEND") return length === 0 && end === body.length;
    offset = end;
  }
  return false;
}

/** Verify the whole decode, with a pixel budget, before exposing an image preview. */
export async function validImage(body: Buffer, type: string): Promise<boolean> {
  if (imageType(body) !== type) return false;
  if (type === "image/png" && !staticPng(body)) return false;
  try {
    const sharp = (await import("sharp")).default;
    await sharp(body, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "warning", animated: true })
      .raw()
      .toBuffer();
    return true;
  } catch {
    return false;
  }
}

/** All file bytes stay in a base64 image URL; none become HTML, CSS or selectors. */
export function imagePage(body: Buffer, type: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Image preview</title><style>
@font-face{font-family:Geist;src:url('/__foom__/geist.ttf')} :root{color-scheme:light;--bg:#f3f0fa;--surface:#e9e4f5;--line:#ddd6ee;--ink:#14101f;--accent:#5b2bd9}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#05040a;--surface:#0d0a17;--line:#251d3f;--ink:#f4efff;--accent:#9b6bff}}*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:13px Geist,system-ui,sans-serif}body{display:flex;flex-wrap:wrap;align-content:flex-start;gap:8px;padding:12px}label{padding:5px 10px;border:1px solid var(--line);border-radius:5px;cursor:pointer;background:var(--surface)}input{position:absolute;opacity:0}input:focus-visible+label{outline:2px solid var(--accent);outline-offset:2px}input:checked+label{border-color:var(--accent)}main{width:100%;height:calc(100% - 42px);overflow:auto;display:grid;place-items:center}img{display:block;max-width:100%;max-height:100%;object-fit:contain}#actual:checked~main{display:block}#actual:checked~main img{max-width:none;max-height:none}
</style></head><body><input type="radio" name="size" id="fit" checked><label for="fit">Fit</label><input type="radio" name="size" id="actual"><label for="actual">Actual size</label><main><img alt="Preview image" src="data:${type};base64,${body.toString("base64")}"></main></body></html>`;
}
