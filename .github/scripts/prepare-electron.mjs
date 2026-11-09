import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export function transientDownloadError(error) {
  // Check typed HTTP failures before walking fetch's nested network causes.
  if (error?.response?.status !== undefined)
    return error.response.status >= 500 && error.response.status <= 599;
  if (error?.name === "ChecksumMismatchError") return false;
  if (error?.name === "TimeoutError") return true;
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(error?.code)
  )
    return true;
  return error?.cause ? transientDownloadError(error.cause) : false;
}

export async function retryDownload(download, { sleep = setTimeout, log = console.log } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await download();
    } catch (error) {
      if (!transientDownloadError(error) || attempt === 3)
        throw new Error(`Electron download failed on attempt ${attempt}/3: ${error.message}`, {
          cause: error,
        });
      log(
        `Electron download attempt ${attempt}/3 failed: ${error.message}; retrying in ${attempt * 2}s`,
      );
      await sleep(attempt * 2000);
    }
  }
}

// Forge otherwise requests SHASUMS256.txt even on a ZIP cache hit. Only the CI
// checkout is augmented; local/release config and all existing hooks stay intact.
export const packagingConfig = `
module.exports.packagerConfig.download = {
  ...module.exports.packagerConfig.download,
  cacheRoot: process.env.electron_config_cache,
  checksums: require("electron/checksums.json"),
};
`;

async function main() {
  const { version } = require("electron/package.json");
  if (process.argv[2] === "cache") {
    // pnpm's frozen installation resolves this exact version from the lockfile.
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
    appendFileSync(
      process.env.GITHUB_ENV,
      `electron_config_cache=${join(process.env.RUNNER_TEMP, "electron-cache")}\n`,
    );
    return;
  }
  const { downloadArtifact } = await import("@electron/get");
  await retryDownload(() =>
    downloadArtifact({
      version,
      artifactName: "electron",
      platform: process.platform,
      arch: process.arch,
      cacheRoot: process.env.electron_config_cache,
      checksums: require("electron/checksums.json"),
      // Bound individual requests within the existing three-minute step budget.
      downloadOptions: { signal: AbortSignal.timeout(45_000) },
    }),
  );
  // The installer reads the same ZIP cache and bundled checksums before extracting.
  const result = spawnSync(process.execPath, [require.resolve("electron/install.js")], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Electron installation failed (${result.status})`);
  if (process.argv[2] === "packaging") appendFileSync("forge.config.js", packagingConfig);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
