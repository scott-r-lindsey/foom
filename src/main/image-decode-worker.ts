import { decodeImage, decodeThemeBitmap } from "./image-decode";
const port = process.parentPort;
let used = false;
port.on("message", (event: { data: unknown }) => {
  if (used) return;
  used = true;
  const input = event.data;
  const decode =
    input instanceof Uint8Array
      ? decodeImage(input)
      : input &&
          typeof input === "object" &&
          "bitmap" in input &&
          input.bitmap instanceof Uint8Array
        ? decodeThemeBitmap(input.bitmap)
        : undefined;
  if (!decode) {
    port.postMessage(null);
    return;
  }
  void decode.then(
    (result) => {
      port.postMessage(result);
    },
    () => {
      port.postMessage(null);
    },
  );
});
