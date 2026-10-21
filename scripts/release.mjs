import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export function releaseFiles(directory, version) {
  const files = globSync(`${directory}/**/*`).filter((file) => /\.(zip|dmg|deb|rpm)$/.test(file));
  assert.equal(files.length, 5, "Expected macOS ZIP/DMG and Linux ZIP/deb/rpm only");
  for (const pattern of [
    new RegExp(`-darwin-arm64-${RegExp.escape(version)}\\.zip$`),
    new RegExp(`-linux-x64-${RegExp.escape(version)}\\.zip$`),
    new RegExp(`Foom-${RegExp.escape(version)}-arm64\\.dmg$`),
    new RegExp(`foom_${RegExp.escape(version)}_amd64\\.deb$`),
    new RegExp(`foom-${RegExp.escape(version)}-1\\.x86_64\\.rpm$`),
  ])
    assert.equal(
      files.filter((file) => pattern.test(file)).length,
      1,
      "Missing or duplicate release format",
    );
  assert.equal(
    new Set(files.map((file) => basename(file))).size,
    files.length,
    "Duplicate release asset names",
  );
  return files;
}

export async function publishRelease({ github, context, execute = execFileSync, Publisher }) {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(context.eventName, "push");
  assert.equal(
    context.ref,
    `refs/tags/v${manifest.version}`,
    "Tag must match the committed version",
  );
  const git = (args) => execute("git", args, { encoding: "utf8" }).trim();
  const sha = git(["rev-parse", "HEAD"]);
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(git(["rev-parse", `${context.ref}^{commit}`]), sha);
  execute("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...context.repo,
    workflow_id: "ci.yml",
    branch: "main",
    event: "push",
    status: "success",
    head_sha: sha,
    per_page: 100,
  });
  const run = runs.find(
    (run) =>
      run.head_sha === sha &&
      run.head_branch === "main" &&
      run.event === "push" &&
      run.conclusion === "success",
  );
  assert.ok(run, "No successful main-push CI run for this tag; wait for CI before tagging");
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo,
    run_id: run.id,
    per_page: 100,
  });
  for (const name of ["Quality gate", "Sign and notarize tested macOS ZIP and DMG"])
    assert.ok(
      jobs.some((job) => job.name === name && job.conclusion === "success"),
      `Missing successful ${name}`,
    );
  execute(
    "gh",
    [
      "run",
      "download",
      String(run.id),
      "--name",
      "Foom-ubuntu-24.04",
      "--name",
      "Foom-macos-signed",
      "--dir",
      "release-packages",
    ],
    { stdio: "inherit" },
  );
  const files = releaseFiles("release-packages", manifest.version);
  // A retry may resume a draft, but must never mutate a published release or
  // silently accept different existing bytes (Forge otherwise skips duplicates).
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...context.repo,
    per_page: 100,
  });
  const existing = releases.find((release) => release.tag_name === `v${manifest.version}`);
  if (existing) {
    assert.equal(existing.draft, true, "Refusing to change a published release");
    const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
      ...context.repo,
      release_id: existing.id,
      per_page: 100,
    });
    for (const file of files) {
      const asset = assets.find((asset) => asset.name === basename(file));
      if (asset)
        assert.equal(
          asset.digest,
          `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`,
          "Existing draft asset differs",
        );
    }
  }
  const config = createRequire(import.meta.url)("../forge.config.js");
  if (!Publisher)
    ({ PublisherGitHub: Publisher } = await import("@electron-forge/publisher-github"));
  const publisher = new Publisher(config.publishers[0].config);
  await publisher.publish({
    dir: process.cwd(),
    forgeConfig: config,
    makeResults: [{ artifacts: files, packageJSON: manifest, platform: "darwin", arch: "arm64" }],
    setStatusLine: console.info,
  });
}
