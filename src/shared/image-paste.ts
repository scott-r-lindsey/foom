import type { ImagePut, ImagePutResult } from "./image-paste.d";
import { record, keys, remotePath } from "./remote-agent-protocol";

export const IMAGE_BYTES = 4 * 1024 * 1024;
export const IMAGE_PIXELS = 16_000_000;
export const IMAGE_FILES = 16;
export const IMAGE_SESSION_BYTES = 32 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 60_000;
/** Build-owned, measured recipient facts; config manifests cannot claim this gate. */
const imageRecipients: Readonly<Record<string, boolean>> = Object.freeze({
  claude: true,
  codex: true,
  pi: true,
});
export function imagePasteRecipient(agent: string): boolean {
  return Object.hasOwn(imageRecipients, agent);
}

export const imageNonce = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export const imageUploadId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
export function imageDimensions(width: number, height: number): boolean {
  return (
    width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= IMAGE_PIXELS
  );
}
/** Only normalized PNGs travel to hosts; decoding belongs to the hub. */
export function imagePng(bytes: Uint8Array): boolean {
  if (bytes.length < 33 || bytes.length > IMAGE_BYTES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a &&
    view.getUint32(8) === 13 &&
    view.getUint32(12) === 0x49484452 &&
    imageDimensions(view.getUint32(16), view.getUint32(20))
  );
}
export function imagePut(value: unknown): value is ImagePut {
  return (
    record(value) &&
    keys(value, ["type", "id", "owner", "upload", "size", "sha256", "data"]) &&
    value["type"] === "image-put" &&
    typeof value["id"] === "string" &&
    /^[a-zA-Z0-9_-]{1,200}$/u.test(value["id"]) &&
    imageNonce(value["owner"]) &&
    imageUploadId(value["upload"]) &&
    imageNonce(value["sha256"]) &&
    typeof value["size"] === "number" &&
    Number.isSafeInteger(value["size"]) &&
    value["size"] >= 33 &&
    value["size"] <= IMAGE_BYTES &&
    typeof value["data"] === "string" &&
    value["data"].length === 4 * Math.ceil(value["size"] / 3) &&
    !/[^A-Za-z0-9+/]/u.test(
      value["data"].slice(
        0,
        value["data"].length - (value["size"] % 3 === 0 ? 0 : 3 - (value["size"] % 3)),
      ),
    ) &&
    value["data"].endsWith("=".repeat(value["size"] % 3 === 0 ? 0 : 3 - (value["size"] % 3)))
  );
}
export function imagePutResult(value: unknown): value is ImagePutResult {
  return (
    record(value) &&
    keys(value, ["type", "id", "owner", "upload", "ok", "path"]) &&
    value["type"] === "image-result" &&
    typeof value["id"] === "string" &&
    /^[a-zA-Z0-9_-]{1,200}$/u.test(value["id"]) &&
    imageNonce(value["owner"]) &&
    imageUploadId(value["upload"]) &&
    (value["ok"] === false
      ? value["path"] === undefined
      : value["ok"] === true &&
        typeof value["path"] === "string" &&
        remotePath(value["path"]) &&
        value["path"].length <= 4096 &&
        /^\/[^\p{Cc}]*\/\.foom-host\/images\/[a-f0-9]{32}\/image-[a-f0-9]{32}\.png$/u.test(
          value["path"],
        ))
  );
}
/** TUIs receive literal reference text, never an executable command. */
export function imageLabel(path: string, windows = false): string {
  if (!path || path.length > 4096 || /\p{Cc}/u.test(path)) throw new Error("Invalid image path");
  const quoted = windows ? path.replaceAll("'", "''") : path.replaceAll("'", "'\\''");
  return `[pasted image '${quoted}'] `;
}

/** Only transient deletion failures retry; unsafe paths fail closed immediately. */
export async function imageCleanup(remove: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await remove();
      return;
    } catch (error) {
      if (
        !record(error) ||
        !["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(String(error["code"])) ||
        attempt === 2
      )
        throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 100 : 500));
    }
  }
}
