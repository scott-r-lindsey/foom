import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";

export const hostPlatforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Read the checkout, never a caller-supplied CI revision or a catalog entry. */
export function checkoutRevision(root, execute = execFileSync) {
  const revision = execute("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert.match(revision, /^[a-f0-9]{40}$/, "Invalid checkout source revision");
  return revision;
}

export async function writeHostManifest(output, { version, platform, arch, source }) {
  assert.ok(hostPlatforms.includes(`${platform}-${arch}`), "Unsupported host build platform");
  const bytes = await readFile(join(output, "foom-host"));
  const started = performance.now();
  const compressed = await promisify(gzip)(bytes, { level: 1 });
  const gzipMs = performance.now() - started;
  const manifest = {
    version,
    platform,
    arch,
    source,
    protocol: 1,
    size: bytes.length,
    sha256: digest(bytes),
    gzipSize: compressed.length,
    gzipSha256: digest(compressed),
  };
  await writeFile(join(output, "foom-host.gz"), compressed);
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest));
  console.info(
    JSON.stringify({
      ...manifest,
      gzipMs,
      gzipLevel: 1,
      savedPercent: 100 * (1 - compressed.length / bytes.length),
    }),
  );
  return manifest;
}

/** CI cannot opt out; local release rehearsals can explicitly opt in. */
export function requireRemoteHosts(env = process.env) {
  return Boolean(env.CI || env.GITHUB_ACTIONS || env.FOOM_REQUIRE_REMOTE_HOSTS === "1");
}

/** Local packages omit the entire catalog if any entry fails strict validation. */
export async function prepareRemoteHosts(
  source,
  output,
  version,
  revision,
  env = process.env,
  warn = console.warn,
) {
  try {
    await packageRemoteHosts(source, output, version, revision);
    return true;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    if (requireRemoteHosts(env)) throw error;
    warn(
      `Remote host artifact unavailable: omitting local catalog (${error.message}). Remote shells require a valid artifact override. Set FOOM_REQUIRE_REMOTE_HOSTS=1 for strict packaging.`,
    );
    return false;
  }
}

/** Fail packaging rather than silently ship a partial, stale or corrupt catalog. */
export async function packageRemoteHosts(source, output, version, revision) {
  for (const target of hostPlatforms) {
    const directory = join(source, target);
    await verifyHostArtifact(directory, target, version, revision);
    const destination = join(output, target);
    await mkdir(destination, { recursive: true });
    for (const name of ["manifest.json", "foom-host.gz"])
      await cp(join(directory, name), join(destination, name));
  }
}

/** Shared pre/post-signing verification of the complete bootstrap byte contract. */
export async function verifyHostArtifact(directory, target, version, revision) {
  assert.match(revision ?? "", /^[a-f0-9]{40}$/, "Invalid expected source revision");
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.ok(manifest && typeof manifest === "object", "Invalid host manifest");
  assert.equal(`${manifest.platform}-${manifest.arch}`, target, "Host target mismatch");
  assert.equal(manifest.version, version, "Host version mismatch");
  assert.equal(manifest.protocol, 1, "Host protocol mismatch");
  assert.ok(
    typeof manifest.source === "string" && /^[a-f0-9]{40}$/.test(manifest.source),
    "Invalid host source revision",
  );
  assert.equal(manifest.source, revision, "Host source revision mismatch");
  for (const key of ["size", "gzipSize"])
    assert.ok(
      Number.isSafeInteger(manifest[key]) &&
        manifest[key] > 0 &&
        manifest[key] <= 200 * 1024 * 1024,
      "Invalid host size",
    );
  const compressed = await readFile(join(directory, "foom-host.gz"));
  assert.equal(compressed.length, manifest.gzipSize, "Host gzip size mismatch");
  assert.equal(digest(compressed), manifest.gzipSha256, "Host gzip hash mismatch");
  const bytes = await promisify(gunzip)(compressed, { maxOutputLength: manifest.size });
  assert.equal(bytes.length, manifest.size, "Host size mismatch");
  assert.equal(digest(bytes), manifest.sha256, "Host hash mismatch");
  return { manifest, bytes };
}
