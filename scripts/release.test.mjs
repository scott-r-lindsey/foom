import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishRelease, releaseFiles } from "./release.mjs";

function fixture(t) {
  const cwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "foom-release-"));
  t.after(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });
  process.chdir(root);
  writeFileSync("package.json", '{"version":"0.1.0"}');
  mkdirSync("release-packages");
  for (const name of [
    "Foom-darwin-arm64-0.1.0.zip",
    "Foom-linux-x64-0.1.0.zip",
    "Foom-0.1.0-arm64.dmg",
    "foom_0.1.0_amd64.deb",
    "foom-0.1.0-1.x86_64.rpm",
  ])
    writeFileSync(join("release-packages", name), "fixture package");
  const sha = "a".repeat(40);
  const context = {
    eventName: "push",
    ref: "refs/tags/v0.1.0",
    repo: { owner: "fixture", repo: "fixture" },
  };
  const calls = [];
  const runs = [
    { id: 42, head_sha: sha, head_branch: "main", event: "push", conclusion: "success" },
  ];
  const jobs = ["Quality gate", "Sign and notarize tested macOS ZIP and DMG"].map((name) => ({
    name,
    conclusion: "success",
  }));
  const releases = [];
  const github = {
    rest: {
      actions: { listWorkflowRuns() {}, listJobsForWorkflowRun() {} },
      repos: { listReleases() {}, listReleaseAssets() {} },
    },
    paginate: async (method) => {
      if (method === github.rest.actions.listWorkflowRuns) return runs;
      if (method === github.rest.actions.listJobsForWorkflowRun) return jobs;
      if (method === github.rest.repos.listReleases) return releases;
      return [{ name: "Foom-darwin-arm64-0.1.0.zip", digest: "wrong" }];
    },
  };
  const options = {
    github,
    context,
    execute: (command, args) => {
      calls.push([command, args]);
      if (command === "git" && args[0] === "rev-parse") return sha;
      return "";
    },
    Publisher: class {
      constructor(config) {
        assert.equal(config.draft, true);
      }
      async publish(options) {
        calls.push(["publish", options]);
      }
    },
  };
  return { options, calls, runs, jobs, releases };
}

test("release publisher consumes only tested same-commit main artifacts and creates a draft", async (t) => {
  const { options, calls } = fixture(t);
  await publishRelease(options);
  assert.ok(calls.some(([command, args]) => command === "git" && args[0] === "merge-base"));
  const download = calls.find(([command]) => command === "gh");
  assert.deepEqual(download[1].slice(0, 3), ["run", "download", "42"]);
  assert.ok(!download[1].includes("Foom-windows-2025"));
  assert.equal(calls.at(-1)[0], "publish");
  assert.equal(calls.at(-1)[1].makeResults[0].artifacts.length, 5);
});

test("wrong tags, failed gates, missing signing, off-main runs and mismatched commits fail closed", async (t) => {
  const { options, calls, runs, jobs } = fixture(t);
  for (const ref of ["refs/heads/main", "refs/tags/v9.9.9"])
    await assert.rejects(publishRelease({ ...options, context: { ...options.context, ref } }));
  assert.equal(calls.length, 0);
  const original = { ...runs[0] };
  for (const change of [
    { head_sha: "b".repeat(40) },
    { head_branch: "topic" },
    { event: "pull_request" },
    { conclusion: "failure" },
  ]) {
    Object.assign(runs[0], original, change);
    await assert.rejects(publishRelease(options), /No successful main-push/);
  }
  Object.assign(runs[0], original);
  jobs[1].conclusion = "skipped";
  await assert.rejects(publishRelease(options), /Missing successful/);
  jobs[1].conclusion = "success";
  jobs[0].conclusion = "failure";
  await assert.rejects(publishRelease(options), /Missing successful/);
  assert.ok(!calls.some(([command]) => command === "gh" || command === "publish"));
});

test("release retries refuse published releases and differing draft assets", async (t) => {
  const { options, releases } = fixture(t);
  releases.push({ tag_name: "v0.1.0", draft: false });
  await assert.rejects(publishRelease(options), /published release/);
  releases[0].draft = true;
  await assert.rejects(publishRelease(options), /Existing draft asset differs/);
});

test("missing formats, nightly ZIPs and Windows assets cannot enter a versioned release", (t) => {
  fixture(t);
  writeFileSync("release-packages/windows.exe", "unsigned");
  assert.equal(releaseFiles("release-packages", "0.1.0").length, 5);
  writeFileSync("release-packages/extra.zip", "extra");
  assert.throws(() => releaseFiles("release-packages", "0.1.0"));
  rmSync("release-packages/extra.zip");
  rmSync("release-packages/Foom-linux-x64-0.1.0.zip");
  writeFileSync("release-packages/Foom-linux-x64-0.1.0-nightly.zip", "wrong version");
  assert.throws(() => releaseFiles("release-packages", "0.1.0"));
});

test("tag workflow confines write permission to the publisher and never holds Apple credentials", async () => {
  const { readFileSync } = await import("node:fs");
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /push:\n {4}tags: \['v\*'\]/);
  assert.equal(workflow.match(/contents: write/g).length, 1);
  assert.match(workflow, /jobs:\n {2}release:/);
  assert.match(workflow, /publishRelease\(\{ github, context \}\)/);
  assert.doesNotMatch(workflow, /secrets\.|environment: Release|pnpm run (make|build)/);
});
