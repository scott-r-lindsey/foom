import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout } from "node:timers/promises";

const artifactName = "Foom-macos-15";
const artifactService = "/twirp/github.actions.results.api.v1.ArtifactService/";

function resultScope(token) {
  try {
    const scopes = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).scp;
    return (
      typeof scopes === "string" && /(?:^| )Actions\.Results:([^: ]+):([^: ]+)(?: |$)/.exec(scopes)
    );
  } catch {
    return null;
  }
}

export async function downloadTestedMacOS({
  env = process.env,
  request = fetch,
  sleep = setTimeout,
  log = console.log,
  extract = (zip) => execFileSync("/usr/bin/ditto", ["-x", "-k", zip, "tested-macos"], { env: {} }),
} = {}) {
  const {
    ACTIONS_RESULTS_URL: resultsUrl,
    ACTIONS_RUNTIME_TOKEN: token,
    TESTED_ARTIFACT_ID: id,
    TESTED_ARTIFACT_DIGEST: digest,
    RUNNER_TEMP: temp,
  } = env;
  if (!id || !/^[1-9]\d*$/.test(id) || !digest || !/^[a-f0-9]{64}$/.test(digest) || !temp) {
    throw new Error("Missing or invalid tested macOS upload metadata");
  }

  // Use the same runner Results service and job scope as the pinned artifact action.
  const scope = resultScope(token);
  if (!scope || !resultsUrl || new URL(resultsUrl).protocol !== "https:") {
    throw new Error("Missing GitHub Actions artifact runtime context");
  }
  const job = { workflowRunBackendId: scope[1], workflowJobRunBackendId: scope[2] };

  async function requestOnce(url, operation, options) {
    let response;
    try {
      response = await request(url, { ...options, redirect: "error" });
    } catch {
      throw new Error(`${operation} request failed`);
    }
    if (response.status !== 200) {
      throw new Error(`${operation} failed with HTTP ${response.status}`);
    }
    return response;
  }

  async function artifactRequest(method, fields) {
    const response = await requestOnce(
      new URL(artifactService + method, resultsUrl),
      `Artifact service ${method}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...job, ...fields }),
      },
    );
    try {
      return await response.json();
    } catch {
      throw new Error(`Invalid artifact service ${method} response`);
    }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`Looking up ${artifactName} (ID ${id}), attempt ${attempt}/3`);
    // Protobuf JSON may omit the empty repeated field.
    const result = await artifactRequest("ListArtifacts", { idFilter: id });
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Invalid artifact lookup response");
    }
    const artifacts = Object.keys(result).length === 0 ? [] : result.artifacts;
    if (!Array.isArray(artifacts)) throw new Error("Invalid artifact lookup response");
    if (artifacts.length > 0) {
      const [artifact] = artifacts;
      if (
        artifacts.length !== 1 ||
        String(artifact?.databaseId ?? artifact?.database_id) !== id ||
        artifact?.name !== artifactName ||
        (artifact.workflowRunBackendId ?? artifact.workflow_run_backend_id) !==
          job.workflowRunBackendId ||
        (artifact.workflowJobRunBackendId ?? artifact.workflow_job_run_backend_id) !==
          job.workflowJobRunBackendId
      ) {
        throw new Error("Artifact lookup returned an unexpected artifact");
      }
      break;
    }
    if (attempt === 3) throw new Error(`${artifactName} (ID ${id}) not found after 3 attempts`);
    log("Artifact not found, retrying in 2 seconds");
    await sleep(2000);
  }

  const result = await artifactRequest("GetSignedArtifactURL", { name: artifactName });
  const signedUrl = result.signedUrl ?? result.signed_url;
  if (typeof signedUrl !== "string" || !signedUrl.startsWith("https://")) {
    throw new Error("Artifact service did not return an HTTPS download URL");
  }
  const directory = await mkdtemp(join(temp, "tested-macos-"));
  try {
    const response = await requestOnce(signedUrl, "Artifact download");
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
