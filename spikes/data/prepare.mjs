// Network/build preparation is deliberately separate from the measured runner.
import { downloadArtifact } from "@electron/get";
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { retryDownload } from "../../.github/scripts/prepare-electron.mjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));
const { version } = require("electron/package.json");
const artifact = await retryDownload(() => downloadArtifact({
  version, artifactName: "electron", platform: process.platform, arch: process.arch,
  checksums: require("electron/checksums.json"), cacheRoot: process.env.electron_config_cache,
  downloadOptions: { signal: AbortSignal.timeout(45_000) },
}));
const zipDir = join(root, ".cache/data-spike-electron");
await mkdir(zipDir, { recursive: true });
await copyFile(artifact, join(zipDir, `electron-v${version}-${process.platform}-${process.arch}.zip`));
execFileSync(process.execPath, [require.resolve("electron/install.js")], { stdio: "inherit" });
