import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assets,
  buildIdentity,
  checksums,
  identity,
  nightlyRequested,
  publish,
} from "./nightly.mjs";

const sha = "a".repeat(40);
test("nightly requires main and a schedule or explicit dispatch", () => {
  for (const event of ["pull_request", "push", "workflow_dispatch", "schedule"]) {
    for (const ref of ["refs/heads/main", "refs/heads/topic", "refs/pull/1/merge"]) {
      for (const input of [true, false, "true", undefined]) {
        assert.equal(
          nightlyRequested(event, ref, input),
          ref === "refs/heads/main" &&
            (event === "schedule" || (event === "workflow_dispatch" && input === true)),
        );
      }
    }
  }
});
test("version and asset identity reject malformed input and use UTC commit date", () => {
  assert.equal(
    identity(sha, "2026-10-08T23:00:00-07:00", "0.1.0").version,
    "0.1.0-nightly.20261009+aaaaaaa",
  );
  for (const values of [
    ["--evil", "2026-10-08T00:00:00Z", "0.1.0"],
    [sha, "invalid", "0.1.0"],
    [sha, "2026-99-99T00:00:00Z", "0.1.0"],
    [sha, "2026-10-08T00:00:00Z", "0.1.0\n"],
  ])
    assert.throws(() => identity(...values));
});

function fixture(context) {
  const gitEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")),
  );
  for (const key of Object.keys(gitEnvironment)) delete process.env[key];
  context.after(() => Object.assign(process.env, gitEnvironment));
  const cwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "foom-nightly-"));
  context.after(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });
  process.chdir(root);
  execFileSync("git", ["init", "-q"]);
  writeFileSync("package.json", '{"version":"0.1.0"}');
  mkdirSync("docs");
  writeFileSync("docs/nightly-opening.md", "Opening instructions");
  execFileSync("git", ["add", "."]);
  execFileSync("git", [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "Initial",
  ]);
  const info = buildIdentity();
  mkdirSync("nightly-packages");
  for (const platform of ["darwin-arm64", "linux-x64", "win32-x64"])
    writeFileSync(
      `nightly-packages/Foom-${platform}-${info.version}.zip`,
      Buffer.from([0x50, 0x4b, 3, 4, 1]),
    );
  return {
    info,
    context: {
      eventName: "schedule",
      ref: "refs/heads/main",
      payload: {},
      sha: info.sha,
      repo: { owner: "test", repo: "foom" },
      serverUrl: "https://github.com",
      runId: 42,
    },
  };
}
function api(previous, failure) {
  const calls = [];
  const method = (name, value) => async (args) => {
    calls.push([name, args]);
    if (failure === name) throw Object.assign(new Error("API unavailable"), { status: 503 });
    if (name === "getReleaseByTag" && !previous)
      throw Object.assign(new Error("Absent"), { status: 404 });
    return { data: value };
  };
  return {
    calls,
    github: {
      paginate: async () => [],
      rest: {
        repos: {
          getReleaseByTag: method("getReleaseByTag", previous),
          getCommit: method("getCommit", { sha: previous?.sha }),
          compareCommits: method("compareCommits", { status: previous?.status ?? "ahead" }),
          createRelease: method("createRelease", { id: 10 }),
          uploadReleaseAsset: method("uploadReleaseAsset", {}),
          updateRelease: method("updateRelease", {}),
          deleteReleaseAsset: method("deleteReleaseAsset", {}),
        },
        git: { updateRef: method("updateRef", {}) },
      },
    },
  };
}
test("complete asset set is validated before publication; hashes cover exact bytes", async (t) => {
  const { info, context } = fixture(t);
  const packages = assets("nightly-packages", info);
  assert.equal(packages.length, 3);
  assert.match(checksums(packages), /^[a-f0-9]{64} {2}foom-nightly-/);
  assert.equal(checksums(packages).split("\n").filter(Boolean).length, 3);
  rmSync(`nightly-packages/Foom-linux-x64-${info.version}.zip`);
  const mock = api();
  await assert.rejects(publish({ ...mock, context }), /three nightly/);
  assert.deepEqual(mock.calls, []);
});
test("first nightly uploads three ZIPs and checksums then publishes a non-latest prerelease", async (t) => {
  const { context } = fixture(t);
  const mock = api();
  await publish({ ...mock, context });
  assert.equal(mock.calls.filter(([name]) => name === "uploadReleaseAsset").length, 4);
  const final = mock.calls.at(-1);
  assert.equal(final[0], "updateRelease");
  assert.equal(final[1].draft, false);
  assert.equal(final[1].prerelease, true);
  assert.equal(final[1].make_latest, "false");
  assert.match(final[1].body, /actions\/runs\/42/);
  assert.equal(
    mock.calls.find(([name]) => name === "createRelease")[1].target_commitish,
    context.sha,
  );
});
test("API read errors do not become permission to create a release", async (t) => {
  const { context } = fixture(t);
  const mock = api(undefined, "getReleaseByTag");
  await assert.rejects(publish({ ...mock, context }), /unavailable/);
  assert.equal(mock.calls.length, 1);
});
test("duplicate or stale runs leave the previous nightly untouched", async (t) => {
  const { context } = fixture(t);
  for (const previous of [{ sha: context.sha }, { sha, status: "behind" }]) {
    const mock = api({ id: 10, ...previous });
    await publish({ ...mock, context });
    assert.ok(
      mock.calls.every(([name]) =>
        ["getReleaseByTag", "getCommit", "compareCommits"].includes(name),
      ),
    );
  }
});
test("failed upload never moves the existing tag or updates release notes", async (t) => {
  const { context } = fixture(t);
  const mock = api({ id: 10, sha }, "uploadReleaseAsset");
  // Previous commit must exist locally for the release log.
  mock.github.rest.repos.getCommit = async () => ({ data: { sha: context.sha } });
  // Test an advancing commit.
  execFileSync("git", [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "Next",
  ]);
  const info = buildIdentity();
  for (const platform of ["darwin-arm64", "linux-x64", "win32-x64"]) {
    rmSync(
      `nightly-packages/Foom-${platform}-${identity(context.sha, info.date, "0.1.0").version}.zip`,
    );
    writeFileSync(
      `nightly-packages/Foom-${platform}-${info.version}.zip`,
      Buffer.from([0x50, 0x4b, 3, 4, 1]),
    );
  }
  await assert.rejects(publish({ ...mock, context: { ...context, sha: info.sha } }), /unavailable/);
  assert.ok(
    mock.calls.every(
      ([name]) => !["updateRef", "updateRelease", "deleteReleaseAsset"].includes(name),
    ),
  );
});
