import { getAsset } from "node:sea";
import { createRequire } from "node:module";
import { closeSync, constants, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { privateDirectory } from "./private-path";

export function loadNativeModule(name: string): { dir: string; module: unknown } {
  if (name !== "pty" || !["linux", "darwin"].includes(process.platform))
    throw new Error("Unsupported host platform");
  const dir = join(dirname(process.execPath), "native");
  privateDirectory(dir);
  for (const file of process.platform === "darwin" ? ["pty.node", "spawn-helper"] : ["pty.node"]) {
    const bytes = Buffer.from(getAsset(file));
    const path = join(dir, file);
    try {
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        file === "spawn-helper" ? 0o700 : 0o600,
      );
      try {
        writeFileSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    const fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY,
    );
    try {
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        info.size !== bytes.length ||
        createHash("sha256").update(readFileSync(fd)).digest("hex") !==
          createHash("sha256").update(bytes).digest("hex")
      )
        throw new Error("Unsafe native asset");
    } finally {
      closeSync(fd);
    }
  }
  return { dir, module: createRequire(process.execPath)(join(dir, "pty.node")) };
}
