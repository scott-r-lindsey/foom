import { utilityProcess } from "electron";
import { join } from "node:path";
import type { DecodedThemeBitmap } from "../shared/theme-bitmap";
import { imagePng } from "../shared/image-paste";
/** A five-second decode deadline can terminate native work without blocking main. */
function normalize<T>(
  input: Uint8Array | { bitmap: Uint8Array },
  signal: AbortSignal,
  valid: (value: unknown) => value is T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = utilityProcess.fork(join(__dirname, "image-decode-worker.js"), [], {
      stdio: "ignore",
      serviceName: "Foom image decoder",
    });
    const finish = (value?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      child.removeAllListeners();
      child.kill();
      if (valid(value)) resolve(value);
      else reject(new Error("Image decode refused"));
    };
    const cancel = () => {
      finish();
    };
    const timer = setTimeout(cancel, 5000);
    signal.addEventListener("abort", cancel, { once: true });
    child.once("exit", cancel);
    child.once("message", finish);
    child.once("spawn", () => {
      child.postMessage(input);
    });
  });
}

const validPng = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array && imagePng(value);

export function normalizeImage(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
  return normalize(bytes, signal, validPng);
}

function validBitmap(value: unknown): value is DecodedThemeBitmap {
  return (
    typeof value === "object" &&
    value !== null &&
    "png" in value &&
    validPng(value.png) &&
    "colors" in value &&
    Array.isArray(value.colors) &&
    value.colors.length <= 3 &&
    value.colors.every(
      (color: unknown) => typeof color === "string" && /^#[0-9a-f]{6}$/u.test(color),
    )
  );
}

export function normalizeThemeBitmap(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<DecodedThemeBitmap> {
  return normalize({ bitmap: bytes }, signal, validBitmap);
}
