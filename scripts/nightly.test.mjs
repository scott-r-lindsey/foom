import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { gitSync } from "../tests/helpers/git.js";
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
  replaceAssets,
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
  const cwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "foom-nightly-"));
  context.after(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });
  process.chdir(root);
  gitSync(["init", "-q"]);
  writeFileSync("package.json", '{"version":"0.1.0"}');
  mkdirSync("docs");
  writeFileSync("docs/nightly-opening.md", "Opening instructions");
  gitSync(["add", "."]);
  gitSync([
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
          updateReleaseAsset: method("updateReleaseAsset", {}),
        },
        git: { updateRef: method("updateRef", {}), createRef: method("createRef", {}) },
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
  for (const previous of [{ sha, status: "behind" }]) {
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
  gitSync([
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

function publication(failAt) {
  const info = identity(sha, "2026-10-08T00:00:00Z", "0.1.0");
  const packages = ["darwin-arm64", "linux-x64", "win32-x64"].map((platform) => ({
    name: `${platform}.zip`,
    data: Buffer.from(platform),
  }));
  const previousSha = "b".repeat(40);
  let tag = previousSha;
  let release = {
    id: 1,
    name: "old",
    body: `Commit: ${previousSha}\nold notes`,
    draft: false,
    prerelease: true,
  };
  let stored = [
    { id: 1, name: "old.zip", data: Buffer.from("old ZIP") },
    { id: 2, name: "SHA256SUMS", data: Buffer.from("old sums") },
  ];
  let nextId = 3;
  let failed = false;
  const fail = (name) => {
    if (!failed && name === failAt) {
      failed = true;
      throw new Error(`failed ${name}`);
    }
  };
  const github = {
    paginate: async () => stored.map((asset) => ({ ...asset })),
    rest: {
      repos: {
        listReleaseAssets() {},
        async uploadReleaseAsset(asset) {
          fail(asset.name.startsWith("SHA256SUMS-") ? "checksum upload" : "ZIP upload");
          const result = {
            id: nextId++,
            name: asset.name,
            data: asset.data,
            digest: `sha256:${createHash("sha256").update(asset.data).digest("hex")}`,
          };
          stored.push(result);
          return { data: result };
        },
        async updateReleaseAsset({ asset_id, name }) {
          fail(name === "SHA256SUMS" ? "checksum swap" : "checksum backup");
          const asset = stored.find((item) => item.id === asset_id);
          assert.ok(asset);
          assert.ok(!stored.some((item) => item.id !== asset_id && item.name === name));
          asset.name = name;
        },
        async deleteReleaseAsset({ asset_id }) {
          fail("cleanup");
          stored = stored.filter((asset) => asset.id !== asset_id);
        },
        async updateRelease(args) {
          fail("notes");
          release = { ...release, ...args };
        },
      },
      git: {
        async updateRef({ sha: value }) {
          fail("tag");
          tag = value;
        },
      },
    },
  };
  const run = () =>
    replaceAssets({
      github,
      repo: { owner: "test", repo: "foom" },
      previous: { ...release },
      previousSha: tag,
      info,
      packages,
      body: `Commit: ${sha}\nnew notes`,
    });
  return { run, state: () => ({ tag, release, stored }) };
}

test("publication restores old checksums, tag and notes across commit failures", async () => {
  for (const failure of ["checksum upload", "checksum backup", "checksum swap", "tag", "notes"]) {
    const mock = publication(failure);
    await assert.rejects(mock.run(), /failed/);
    const state = mock.state();
    assert.equal(state.tag, "b".repeat(40), failure);
    assert.equal(state.release.body, `Commit: ${"b".repeat(40)}\nold notes`, failure);
    assert.equal(
      state.stored.find((asset) => asset.name === "SHA256SUMS").data.toString(),
      "old sums",
      failure,
    );
    assert.equal(state.stored.length, 2, failure);
    await mock.run();
    assert.equal(mock.state().tag, sha);
    assert.equal(mock.state().stored.length, 4);
  }
});
test("retry repairs interrupted cleanup even when the tag already matches", async () => {
  const mock = publication("cleanup");
  await assert.rejects(mock.run(), /cleanup/);
  assert.equal(mock.state().tag, sha);
  assert.ok(mock.state().stored.length > 4);
  await mock.run();
  assert.equal(mock.state().stored.length, 4);
  const before = mock.state();
  await mock.run();
  assert.deepEqual(mock.state(), before);
});

test("an interrupted first publish resumes its draft even when the tag endpoint returns 404", async (t) => {
  const { context } = fixture(t);
  const mock = api();
  const draft = { id: 7, tag_name: "nightly", draft: true, prerelease: true };
  mock.github.rest.repos.listReleases = () => {};
  mock.github.paginate = async (method) =>
    method === mock.github.rest.repos.listReleases ? [draft] : [];
  mock.github.rest.repos.getCommit = async () => {
    throw Object.assign(new Error("no tag yet"), { status: 404 });
  };
  await publish({ ...mock, context });
  assert.ok(!mock.calls.some(([name]) => name === "createRelease"));
  assert.equal(mock.calls.find(([name]) => name === "updateRelease")[1].release_id, 7);
});
