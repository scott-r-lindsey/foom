import { decodeImage } from "./image-decode";
const port = process.parentPort;
let used = false;
port.on("message", (event: { data: unknown }) => {
  if (used) return;
  used = true;
  const bytes = event.data;
  if (!(bytes instanceof Uint8Array)) {
    port.postMessage(null);
    return;
  }
  void decodeImage(bytes).then(
    (png) => {
      port.postMessage(png);
    },
    () => {
      port.postMessage(null);
    },
  );
});
