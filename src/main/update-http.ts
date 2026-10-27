import { get } from "node:https";

/** Anonymous, bounded metadata GET. No cookies, credentials, redirects or remote error text. */
export function getUpdateRelease(
  version: string,
  platform: string,
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    !/^https:\/\/api\.github\.com\/repos\/scott-r-lindsey\/foom\/releases\/latest$/.test(url) &&
    !/^https:\/\/foom-term\.com\/updates\/nightly\/(?:darwin-(?:arm64|x64)\/latest-mac|(?:linux|win32)-(?:arm64|x64)\/latest)\.json$/.test(
      url,
    ) &&
    !/^https:\/\/update\.electronjs\.org\/scott-r-lindsey\/foom\/darwin-(?:arm64|x64)\/\d+\.\d+\.\d+$/.test(
      url,
    )
  )
    return Promise.reject(new Error("Invalid update endpoint"));
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      {
        signal,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `Foom/${version} (${platform})`,
        },
      },
      (response) => {
        response.on("error", () => {
          reject(new Error("Update check failed"));
        });
        if (response.statusCode === 404 || response.statusCode === 204) {
          response.resume();
          resolve(null);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error("Update check failed"));
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 262144) request.destroy(new Error("Update response too large"));
        });
        response.on("end", () => {
          try {
            const value: unknown = JSON.parse(body);
            resolve(value);
          } catch {
            reject(new Error("Invalid update response"));
          }
        });
      },
    );
    const timeout = setTimeout(() => request.destroy(new Error("Update check timed out")), 15000);
    timeout.unref();
    request.on("close", () => {
      clearTimeout(timeout);
    });
    request.setTimeout(15000, () => request.destroy(new Error("Update check timed out")));
    request.on("error", () => {
      reject(new Error("Update check failed"));
    });
  });
}
