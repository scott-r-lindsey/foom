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
    // The tag endpoint only promises published releases. Recover a draft left
    // by an interrupted first publish through the authenticated release list.
    const drafts = (
      await github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 })
    ).filter((release) => release.tag_name === "nightly" && release.draft);
    if (drafts.length > 1)
      throw new Error("Multiple nightly drafts require manual reconciliation", { cause: error });
    previous = drafts[0];
  }
  let previousSha;
  if (previous) {
    try {
      previousSha = (await github.rest.repos.getCommit({ ...repo, ref: "nightly" })).data.sha;
    } catch (error) {
      if (error.status !== 404 || !previous.draft) throw error;
    }
    if (previousSha && !/^[a-f0-9]{40}$/.test(previousSha))
      throw new Error("Invalid previous nightly commit");
    if (previousSha && previousSha !== info.sha) {
      const comparison = await github.rest.repos.compareCommits({
        ...repo,
        base: previousSha,
        head: info.sha,
      });
      if (comparison.data.status !== "ahead") return;
    }
  }
  const range = previousSha ? `${previousSha}..${info.sha}` : info.sha;
  const commits = execFileSync("git", ["log", "--first-parent", "--format=%h %s", range, "--"], {
    encoding: "utf8",
  });
  const opening = readFileSync("docs/nightly-opening.md", "utf8");
  const generatedBody = `Commit: ${info.sha}\nCommit date: ${info.date}\nVersion: ${info.version}\n[CI run](${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId})\n\n${opening}\n\n## Main commits since the previous nightly\n\n${commits
    .split("\n")
    .filter(Boolean)
    .map((line) => `- ${line.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}`)
    .join("\n")}\n`;
  // A retry after tag/notes update retains the original changelog.
  const body =
    previousSha === info.sha && previous?.body?.startsWith(`Commit: ${info.sha}\n`)
      ? previous.body
      : generatedBody;
  await replaceAssets({ github, repo, previous, previousSha, info, packages, body });
}

export async function replaceAssets({ github, repo, previous, previousSha, info, packages, body }) {
  const desired = [...packages, { name: "SHA256SUMS", data: Buffer.from(checksums(packages)) }];
  const digest = (data) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
  const list = (id) =>
    github.paginate(github.rest.repos.listReleaseAssets, {
      ...repo,
      release_id: id,
      per_page: 100,
    });
  const oldAssets = previous ? await list(previous.id) : [];
  const oldZips = packages.map((asset) => oldAssets.find((old) => old.name === asset.name));
  const completeZips = oldZips.every((asset) => /^sha256:[a-f0-9]{64}$/.test(asset?.digest));
  const oldSums = completeZips
    ? Buffer.from(oldZips.map((asset) => `${asset.digest.slice(7)}  ${asset.name}\n`).join(""))
    : null;
  if (
    previousSha === info.sha &&
    !previous.draft &&
    previous.prerelease &&
    previous.body?.startsWith(`Commit: ${info.sha}\n`) &&
    oldAssets.length === desired.length &&
    oldSums &&
    oldAssets.some((asset) => asset.name === "SHA256SUMS" && asset.digest === digest(oldSums))
  )
    return;
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
  const remove = (id) => github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: id });
  const rename = (id, name) =>
    github.rest.repos.updateReleaseAsset({ ...repo, asset_id: id, name });
  const created = [];
  const upload = async (asset) => {
    const old = oldAssets.find((item) => item.name === asset.name);
    if (old?.digest === digest(asset.data)) return old;
    if (old) await remove(old.id);
    const uploaded = (
      await github.rest.repos.uploadReleaseAsset({
        ...repo,
        release_id: release.id,
        name: asset.name,
        data: asset.data,
        headers: { "content-type": "application/octet-stream" },
      })
    ).data;
    created.push(uploaded.id);
    return uploaded;
  };
  // Stage every byte before touching the current checksums, tag or notes.
  const uploaded = [];
  const stagedName = `SHA256SUMS-${info.sha}`;
  let staged;
  const oldChecksum = oldAssets.find((asset) => asset.name === "SHA256SUMS");
  let backedUp = false;
  let swapped = false;
  let tagChanged = false;
  let notesAttempted = false;
  try {
    for (const asset of packages) uploaded.push(await upload(asset));
    staged = await upload({ name: stagedName, data: Buffer.from(checksums(packages)) });
    if (oldChecksum) {
      await rename(oldChecksum.id, `SHA256SUMS-previous-${oldChecksum.id}`);
      backedUp = true;
    }
    await rename(staged.id, "SHA256SUMS");
    swapped = true;
    if (previousSha)
      await github.rest.git.updateRef({ ...repo, ref: "tags/nightly", sha: info.sha, force: true });
    else await github.rest.git.createRef({ ...repo, ref: "refs/tags/nightly", sha: info.sha });
    tagChanged = true;
    notesAttempted = true;
    await github.rest.repos.updateRelease({
      ...repo,
      release_id: release.id,
      name: `Foom nightly ${info.day} (${info.short})`,
      body,
      draft: false,
      prerelease: true,
      make_latest: "false",
    });
  } catch (error) {
    // REST updates are not atomic. Restore the previous public metadata and
    // checksum asset on a failed commit; report any rollback error as well.
    const recovery = [];
    const restore = async (action) => {
      try {
        await action();
      } catch (failure) {
        recovery.push(failure);
      }
    };
    if (notesAttempted && previous)
      await restore(() =>
        github.rest.repos.updateRelease({
          ...repo,
          release_id: release.id,
          name: previous.name,
          body: previous.body,
          draft: previous.draft,
          prerelease: previous.prerelease,
          make_latest: "false",
        }),
      );
    if (tagChanged)
      await restore(() =>
        previousSha
          ? github.rest.git.updateRef({
              ...repo,
              ref: "tags/nightly",
              sha: previousSha,
              force: true,
            })
          : github.rest.git.deleteRef({ ...repo, ref: "tags/nightly" }),
      );
    if (swapped) await restore(() => rename(staged.id, stagedName));
    if (backedUp) await restore(() => rename(oldChecksum.id, "SHA256SUMS"));
    if (recovery.length === 0) for (const id of created) await restore(() => remove(id));
    if (recovery.length)
      throw new AggregateError(
        [error, ...recovery],
        "Nightly publication and rollback failed; rerun to repair",
        { cause: error },
      );
    throw error;
  }
  // Cleanup is resumable: an identical SHA is skipped only when metadata and
  // the exact asset set are complete, including GitHub's SHA-256 digests.
  const keep = new Set([...uploaded.map((asset) => asset.id), staged.id]);
  for (const old of await list(release.id)) if (!keep.has(old.id)) await remove(old.id);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "stamp") throw new Error("Expected stamp command");
  const info = buildIdentity();
  // CI's disposable checkout only; no version commit or lockfile mutation.
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  manifest.version = info.version;
  writeFileSync("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
}
