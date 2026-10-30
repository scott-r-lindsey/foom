import { clipboard } from "electron";
import { IMAGE_BYTES } from "../../shared/image-paste";

export type ClipboardPaste =
  | { kind: "text"; text: string }
  | { kind: "image"; bytes: Uint8Array }
  | { kind: "empty" | "failed" };
/** One explicit snapshot. Plain text (including whitespace) always wins. */
async function snapshotPaste(): Promise<ClipboardPaste> {
  const items = await clipboard.read();
  for (const item of items) {
    if (!item.types.includes("text/plain")) continue;
    const text = await (await item.getType("text/plain")).text();
    if (text.length) return { kind: "text", text };
  }
  if (
    items.some((item) =>
      item.types.some((type) => type === "text/uri-list" || type.includes("file-list")),
    )
  )
    return { kind: "failed" };
  const images = items.filter((item) => item.types.some((type) => type.startsWith("image/")));
  if (!images.length) return { kind: "empty" };
  const image = images[0];
  if (images.length !== 1 || !image) return { kind: "failed" };
  const type = ["image/png", "image/jpeg", "image/webp", "image/gif"].find((type) =>
    image.types.includes(type),
  );
  if (!type) return { kind: "failed" };
  const blob = await image.getType(type);
  if (!(blob instanceof Blob) || !blob.size || blob.size > IMAGE_BYTES) return { kind: "failed" };
  return { kind: "image", bytes: new Uint8Array(await blob.arrayBuffer()) };
}

/** Clipboard owners cannot hold a detached session or app shutdown indefinitely. */
export function readPaste(signal?: AbortSignal): Promise<ClipboardPaste> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Clipboard paste cancelled"));
      return;
    }
    const finish = (value?: ClipboardPaste) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (value) resolve(value);
      else reject(new Error("Clipboard paste unavailable"));
    };
    const cancel = () => {
      finish();
    };
    const timer = setTimeout(cancel, 5000);
    signal?.addEventListener("abort", cancel, { once: true });
    void snapshotPaste().then(finish, cancel);
  });
}
