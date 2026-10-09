import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function nightlyRequested(event, ref, input) {
  return (
    ref === "refs/heads/main" &&
    (event === "schedule" || (event === "workflow_dispatch" && input === true))
  );
}

export function identity(sha, date, version) {
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    !/^\d+\.\d+\.\d+$/.test(version)
  )
    throw new Error("Invalid nightly identity");
  const day = new Date(date).toISOString().slice(0, 10).replaceAll("-", "");
  return {
    sha,
    date,
    day,
    short: sha.slice(0, 7),
    version: `${version}-nightly.${day}+${sha.slice(0, 7)}`,
  };
}

export function buildIdentity() {
  const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  return identity(
    git(["rev-parse", "HEAD"]),
    git(["show", "-s", "--format=%cI", "HEAD"]),
    JSON.parse(readFileSync("package.json", "utf8")).version,
  );
}

export function assets(directory, info) {
  const files = globSync(`${directory}/**/*.zip`);
  const platforms = ["darwin-arm64", "linux-x64", "win32-x64"];
  if (files.length !== 3) throw new Error("Expected exactly three nightly ZIPs");
  return platforms.map((platform) => {
    const matches = files.filter((file) => file.endsWith(`-${platform}-${info.version}.zip`));
    if (matches.length !== 1) throw new Error(`Missing or duplicate ${platform} nightly ZIP`);
    const data = readFileSync(matches[0]);
    if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) throw new Error("Invalid ZIP");
    return { name: `foom-nightly-${info.day}-${info.short}-${platform}.zip`, data };
  });
}

export function checksums(packages) {
  return packages
    .map(({ name, data }) => `${createHash("sha256").update(data).digest("hex")}  ${name}\n`)
    .join("");
}

// Called only by the gated, serialized contents:write job. GitHub data is text,
// never shell source; even commit ranges are validated full hashes.
export async function publish({ github, context, directory = "nightly-packages" }) {
  if (
    !nightlyRequested(
      context.eventName,
      context.ref,
      context.payload.inputs?.publish_nightly === true ||
        context.payload.inputs?.publish_nightly === "true",
    )
  )
    throw new Error("Nightly publication is restricted to main schedule/opt-in dispatch");
  const info = buildIdentity();
  if (info.sha !== context.sha) throw new Error("Checkout does not match tested commit");
  const packages = assets(directory, info);
  const repo = context.repo;
  let previous;
  try {
    previous = (await github.rest.repos.getReleaseByTag({ ...repo, tag: "nightly" })).data;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  let previousSha;
  if (previous) {
    const commit = await github.rest.repos.getCommit({ ...repo, ref: "nightly" });
    previousSha = commit.data.sha;
    if (!/^[a-f0-9]{40}$/.test(previousSha)) throw new Error("Invalid previous nightly commit");
    if (previousSha === info.sha) return;
    const comparison = await github.rest.repos.compareCommits({
      ...repo,
      base: previousSha,
      head: info.sha,
    });
    if (comparison.data.status !== "ahead") return; // Never let a delayed run roll back nightly.
  }
  const range = previousSha ? `${previousSha}..${info.sha}` : info.sha;
  const commits = execFileSync("git", ["log", "--first-parent", "--format=%h %s", range, "--"], {
    encoding: "utf8",
  });
  const opening = readFileSync("docs/nightly-opening.md", "utf8");
  const body = `Commit: ${info.sha}\nCommit date: ${info.date}\nVersion: ${info.version}\n[CI run](${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId})\n\n${opening}\n\n## Main commits since the previous nightly\n\n${commits
    .split("\n")
    .filter(Boolean)
    .map((line) => `- ${line.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}`)
    .join("\n")}\n`;
  const release =
    previous ??
    (
      await github.rest.repos.createRelease({
        ...repo,
        tag_name: "nightly",
        target_commitish: info.sha,
        name: "Foom nightly",
        body,
        draft: true,
        prerelease: true,
        make_latest: "false",
      })
    ).data;
  const oldAssets = await github.paginate(github.rest.repos.listReleaseAssets, {
    ...repo,
    release_id: release.id,
    per_page: 100,
  });
  // Upload the new ZIPs before removing the old set. A failed upload leaves the
  // old tag and notes available; a rerun replaces only its own partial uploads.
  for (const asset of [
    ...packages,
    { name: "SHA256SUMS", data: Buffer.from(checksums(packages)) },
  ]) {
    const collision = oldAssets.find((old) => old.name === asset.name);
    if (collision) await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: collision.id });
    await github.rest.repos.uploadReleaseAsset({
      ...repo,
      release_id: release.id,
      name: asset.name,
      data: asset.data,
      headers: { "content-type": "application/octet-stream" },
    });
  }
  if (previous)
    await github.rest.git.updateRef({ ...repo, ref: "tags/nightly", sha: info.sha, force: true });
  await github.rest.repos.updateRelease({
    ...repo,
    release_id: release.id,
    name: `Foom nightly ${info.day} (${info.short})`,
    body,
    draft: false,
    prerelease: true,
    make_latest: "false",
  });
  for (const old of oldAssets.filter(
    (old) => old.name !== "SHA256SUMS" && !packages.some((asset) => asset.name === old.name),
  )) {
    await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: old.id });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "stamp") throw new Error("Expected stamp command");
  const info = buildIdentity();
  // CI's disposable checkout only; no version commit or lockfile mutation.
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  manifest.version = info.version;
  writeFileSync("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
}
