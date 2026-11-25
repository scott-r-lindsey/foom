import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout } from "node:timers/promises";

const artifactName = "Foom-macos-15";

export async function downloadTestedMacOS({
  github,
  repository,
  env = process.env,
  request = fetch,
  sleep = setTimeout,
  log = console.log,
  extract = (zip) => execFileSync("/usr/bin/ditto", ["-x", "-k", zip, "tested-macos"], { env: {} }),
}) {
  const { TESTED_ARTIFACT_ID: id, TESTED_ARTIFACT_DIGEST: digest, RUNNER_TEMP: temp } = env;
  if (!id || !/^[1-9]\d*$/.test(id) || !digest || !/^[a-f0-9]{64}$/.test(digest) || !temp) {
    throw new Error("Missing or invalid tested macOS upload metadata");
  }

  let signedUrl;
  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`Requesting ${artifactName} (ID ${id}) from the GitHub REST API, attempt ${attempt}/3`);
    let response;
    let status;
    try {
      response = await github.rest.actions.downloadArtifact({
        ...repository,
        artifact_id: id,
        archive_format: "zip",
        request: {
          fetch: (url, options) => request(url, { ...options, redirect: "manual" }),
        },
      });
      status = response.status;
    } catch (error) {
      // Octokit errors can carry request and response headers. Report only the status.
      status = error?.status;
    }
    if (status === 302 && response) {
      signedUrl = response.headers?.location;
      break;
    }
    if (!Number.isInteger(status)) throw new Error("GitHub artifact REST request failed");
    if (status !== 404 || attempt === 3) {
      throw new Error(
        `GitHub artifact REST request failed with HTTP ${status} on attempt ${attempt}/3`,
      );
    }
    log("Artifact REST request returned HTTP 404, retrying in 2 seconds");
    await sleep(2000);
  }

  if (typeof signedUrl !== "string" || !signedUrl.startsWith("https://")) {
    throw new Error("GitHub artifact REST response did not contain an HTTPS download URL");
  }
  const directory = await mkdtemp(join(temp, "tested-macos-"));
  try {
    let response;
    try {
      response = await request(signedUrl, { redirect: "error", credentials: "omit" });
    } catch {
      throw new Error("Artifact download request failed");
    }
    if (response.status !== 200) {
      throw new Error(`Artifact download failed with HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("Artifact download returned no body");
    const zip = join(directory, "artifact.zip");
    const hash = createHash("sha256");
    await pipeline(
      response.body,
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(zip),
    );
    if (hash.digest("hex") !== digest) throw new Error("Tested macOS artifact digest mismatch");
    extract(zip);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
