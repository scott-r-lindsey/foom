import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:https";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export interface UpdatePackage {
  version: string;
  url: string;
}
export interface LocalUpdate {
  url: string;
  dispose(): Promise<void>;
}

/** The initial URL binds the version and archive to this repository, not a release title. */
export function macUpdatePackage(metadata: unknown, arch: string): UpdatePackage {
  if (typeof metadata !== "object" || metadata === null || !("url" in metadata))
    throw new Error("Invalid update metadata");
  const url = metadata.url;
  if (typeof url !== "string") throw new Error("Invalid update archive");
  const match =
    /^https:\/\/github\.com\/scott-r-lindsey\/foom\/releases\/download\/v(\d+\.\d+\.\d+)\/Foom-darwin-(arm64|x64)-(\d+\.\d+\.\d+)\.zip$/.exec(
      url,
    );
  if (!match?.[1] || match[2] !== arch || match[1] !== match[3])
    throw new Error("Invalid update archive");
  return { version: match[1], url };
}

/** Only GitHub's release-asset CDN, scoped to Foom's immutable repository ID. */
function assetRedirect(url: string): boolean {
  const parsed = new URL(url);
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === "release-assets.githubusercontent.com" &&
    !parsed.username &&
    !parsed.password &&
    !parsed.port &&
    !parsed.hash &&
    /^\/github-production-release-asset\/1394006699\/[a-f0-9-]+$/.test(parsed.pathname)
  );
}

async function download(
  url: string,
  target: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const request = get(url, { signal, headers: { Accept: "application/zip" } }, (response) => {
      response.on("error", reject);
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        response.resume();
        const location = response.headers.location;
        try {
          if (!location || redirects >= 3 || !assetRedirect(location))
            throw new Error("Invalid update redirect");
          void download(location, target, signal, redirects + 1).then(resolve, reject);
        } catch {
          reject(new Error("Invalid update redirect"));
        }
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("Update download failed"));
        return;
      }
      let size = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          callback(size > 1024 * 1024 * 1024 ? new Error("Update archive too large") : null, chunk);
        },
      });
      void pipeline(response, limit, createWriteStream(target, { flags: "wx", mode: 0o600 }), {
        signal,
      }).then(resolve, reject);
    });
    request.setTimeout(15000, () => request.destroy(new Error("Update download timed out")));
    request.on("error", reject);
  });
}

/** Squirrel receives local files only; it never gets a remote URL or remote extra fields. */
export async function prepareLocalUpdate(
  userData: string,
  update: UpdatePackage,
  signal: AbortSignal,
): Promise<LocalUpdate> {
  const directory = await mkdtemp(join(userData, "update-"));
  const dispose = () => rm(directory, { recursive: true, force: true });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => {
      controller.abort();
    },
    20 * 60 * 1000,
  );
  const abort = () => {
    controller.abort();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const archive = join(directory, "update.zip");
    await download(update.url, archive, controller.signal);
    signal.throwIfAborted();
    const feed = join(directory, "feed.json");
    await writeFile(
      feed,
      JSON.stringify({
        currentRelease: update.version,
        releases: [{ version: update.version, updateTo: { url: pathToFileURL(archive).href } }],
      }),
      { mode: 0o600, flag: "wx" },
    );
    return { url: pathToFileURL(feed).href, dispose };
  } catch {
    controller.abort();
    await dispose();
    throw new Error("Update download failed");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
