import { utilityProcess } from "electron";
import { join } from "node:path";
import { imagePng } from "../../shared/image-paste";
/** A five-second decode deadline can terminate native work without blocking main. */
export function normalizeImage(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
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
      if (value instanceof Uint8Array && imagePng(value)) resolve(value);
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
      child.postMessage(bytes);
    });
  });
}
