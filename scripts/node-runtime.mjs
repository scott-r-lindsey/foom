import { dirname, join } from "node:path";

export function nodeRuntimeLicense() {
  const bin = dirname(process.execPath);
  return join(process.platform === "win32" ? bin : dirname(bin), "LICENSE");
}
