import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { generateFeed, uploadFeed } from "./nightly-feed.mjs";
import { identity } from "./nightly.mjs";

const info = identity("a".repeat(40), "2026-10-23T01:00:00Z", "0.1.0");
const zip = Buffer.from([0x50, 0x4b, 3, 4, 1]);
const packages = [
  ...["darwin-arm64", "linux-x64", "win32-x64"].map((target) => ({
    name: `Foom-nightly-${info.day}-${info.short}-${target}.zip`,
    data: Buffer.concat([zip, Buffer.from(target)]),
  })),
  ...["dmg", "deb", "rpm", "exe", "nupkg"].map((ext) => ({
    name: `Foom-nightly-${info.day}-${info.short}-installer.${ext}`,
    data: Buffer.from(`tested ${ext}`),
  })),
];
const config = { bucket: "example-site", distribution: "EXAMPLE123", region: "us-east-1" };
const objects = () => generateFeed([...packages, { name: "test-RELEASES", data: zip }], info);

test("feed paths and immutable URLs bind version, full commit, architecture and checksum", () => {
  const result = objects();
  assert.equal(result.length, 20);
  assert.equal(
    result.some(({ key }) => key.endsWith("RELEASES")),
    false,
  );
  for (const target of ["darwin-arm64", "linux-x64", "win32-x64"]) {
    const mac = target.startsWith("darwin");
    const feed = JSON.parse(
      result.find(
        ({ key }) => key === `updates/nightly/${target}/${mac ? "latest-mac.json" : "latest.json"}`,
      ).data,
    );
    assert.equal(feed.version, info.version);
    assert.equal(feed.commit, info.sha);
    assert.equal(feed.commitDate, info.date);
    assert.equal(
      feed.sha256,
      createHash("sha256")
        .update(packages.find((p) => p.name.endsWith(`${target}.zip`)).data)
        .digest("hex"),
    );
    assert.equal(
      feed.url,
      `https://foom-term.com/updates/nightly/artifacts/${info.sha}/Foom-nightly-${info.day}-${info.short}-${target}.zip`,
    );
    if (mac) {
      assert.equal(feed.currentRelease, "20261023.3600.0");
      assert.deepEqual(feed.releases, [
        { version: "20261023.3600.0", updateTo: { url: feed.url } },
      ]);
    } else assert.equal(feed.releases, undefined);
    const expected = {
      version: info.version,
      commit: info.sha,
      commitDate: info.date,
      sha256: createHash("sha256")
        .update(packages.find((p) => p.name.endsWith(`${target}.zip`)).data)
        .digest("hex"),
      url: `https://foom-term.com/updates/nightly/artifacts/${info.sha}/Foom-nightly-${info.day}-${info.short}-${target}.zip`,
      ...(mac
        ? {
            currentRelease: "20261023.3600.0",
            releases: [{ version: "20261023.3600.0", updateTo: { url: feed.url } }],
          }
        : {}),
    };
    assert.equal(
      result
        .find(
          (o) => o.key === `updates/nightly/${target}/${mac ? "latest-mac.json" : "latest.json"}`,
        )
        .data.toString(),
      `${JSON.stringify(expected, null, 2)}\n`,
    );
  }
});
test("generator rejects missing, duplicate, invalid or path-escaping artifacts and stale identity", () => {
  for (const input of [
    packages.slice(1),
    packages.filter((p) => !p.name.endsWith(".dmg")),
    [...packages, { name: "another.dmg", data: zip }],
    packages.map((p) => ({ ...p, data: Buffer.from([1]) })),
    [...packages, packages[0]],
    [...packages, { name: "../evil", data: zip }],
    packages.map((p) => ({ ...p, data: Buffer.from("not zip") })),
    packages.map((p) => ({ ...p, data: Buffer.alloc(0) })),
  ])
    assert.throws(() => generateFeed(input, info));
  assert.throws(() => generateFeed(packages, { ...info, version: "0.2.0" }));
});
function fakeAws({ existing = new Map(), failPut, failHead, expected = objects() } = {}) {
  const calls = [];
  const aws = (args) => {
    calls.push(args);
    if (args[1] === "list-objects-v2") {
      assert.ok(args.includes("updates/nightly/"));
      if (failHead) throw new Error("Access denied");
      return JSON.stringify([...existing.keys()]);
    }
    const key = args[args.indexOf("--key") + 1];
    const value = existing.get(key);
    if (args[1] === "head-object") {
      if (failHead) throw new Error("Access denied");
      if (!value) throw Object.assign(new Error("missing"), { stderr: "(404)" });
      return JSON.stringify({
        Metadata: value.metadata ?? {
          sha256: value.sha256,
          commit: value.commit,
          commitdate: value.commitDate,
        },
        ContentLength: value.data.length,
      });
    }
    if (args[1] === "get-object") {
      writeFileSync(args[args.indexOf("--region") - 1], value.data);
      return "{}";
    }
    if (args[1] === "put-object") {
      if (key === failPut) throw new Error("upload failed");
      const data = readFileSync(args[args.indexOf("--body") + 1]);
      const object = expected.find((o) => o.key === key);
      assert.deepEqual(data, object.data);
      const metadata = JSON.parse(args[args.indexOf("--metadata") + 1]);
      assert.deepEqual(metadata, {
        sha256: object.sha256,
        ...(!object.immutable ? { commit: object.commit, commitdate: object.commitDate } : {}),
      });
      existing.set(key, { ...object, data, metadata });
    }
    return "{}";
  };
  return { calls, aws };
}
test("uploads immutable bytes, downloads, manifest and feeds, then invalidates exact mutable paths", () => {
  const { calls, aws } = fakeAws();
  uploadFeed(objects(), config, aws);
  const puts = calls.filter((a) => a[1] === "put-object");
  assert.equal(puts.length, 20);
  assert.equal(
    puts.slice(0, 8).every((a) => a.includes("--if-none-match") && a.includes("*")),
    true,
  );
  assert.equal(
    puts.slice(8).some((a) => a.includes("--if-none-match")),
    false,
  );
  assert.deepEqual(calls.at(-1).slice(0, -3), [
    "cloudfront",
    "create-invalidation",
    "--distribution-id",
    config.distribution,
    "--paths",
    ...objects()
      .filter((o) => o.key.startsWith("updates/nightly/download/"))
      .map((o) => `/${o.key}`),
    "/updates/nightly/darwin-arm64/latest-mac.json",
    "/updates/nightly/linux-x64/latest.json",
    "/updates/nightly/win32-x64/latest.json",
  ]);
});
test("identical immutable bytes are reused; changed bytes refuse all writes", () => {
  const existing = new Map(
    objects()
      .filter((o) => o.immutable)
      .map((o) => [o.key, o]),
  );
  let fixture = fakeAws({ existing });
  uploadFeed(objects(), config, fixture.aws);
  assert.equal(fixture.calls.filter((a) => a[1] === "put-object").length, 12);
  existing.set(objects()[0].key, { ...objects()[0], sha256: "b".repeat(64) });
  fixture = fakeAws({ existing });
  assert.throws(() => uploadFeed(objects(), config, fixture.aws), /Immutable/);
  assert.equal(
    fixture.calls.some((a) => a[1] === "put-object"),
    false,
  );
});
test("failed assets, denied access and newer existing feeds never publish metadata", () => {
  let fixture = fakeAws({ failPut: objects()[1].key });
  assert.throws(() => uploadFeed(objects(), config, fixture.aws), /upload failed/);
  assert.equal(
    fixture.calls.some(
      (a) =>
        a[1] === "create-invalidation" || (a[1] === "put-object" && a.includes("application/json")),
    ),
    false,
  );
  fixture = fakeAws({ failHead: true });
  assert.throws(() => uploadFeed(objects(), config, fixture.aws), /Access denied/);
  const feed = objects().at(-1);
  const data = Buffer.from(
    JSON.stringify({ commit: "b".repeat(40), commitDate: "2026-10-24T00:00:00Z" }),
  );
  fixture = fakeAws({ existing: new Map([[feed.key, { ...feed, data }]]) });
  assert.throws(() => uploadFeed(objects(), config, fixture.aws), /backwards/);
  assert.equal(
    fixture.calls.some((a) => a[1] === "put-object"),
    false,
  );
});
test("existing feed retry succeeds and invalid date/config fails closed", () => {
  let fixture = fakeAws({ existing: new Map(objects().map((o) => [o.key, o])) });
  uploadFeed(objects(), config, fixture.aws);
  const feed = objects().at(-1);
  fixture = fakeAws({ existing: new Map([[feed.key, { ...feed, data: Buffer.from("{}") }]]) });
  assert.throws(() => uploadFeed(objects(), config, fixture.aws), /Invalid existing/);
  for (const bad of [
    {},
    { ...config, bucket: "--evil" },
    { ...config, region: "bad" },
    { ...config, distribution: "../evil" },
  ])
    assert.throws(() => uploadFeed(objects(), bad, () => assert.fail("No AWS calls")), /Configure/);
});
test("workflow keeps feed upload inert without role variable and behind Quality/signing gate", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  ).split("  nightly:\n")[1];
  assert.match(workflow, /needs: \[changes, quality, macos-sign\]/);
  assert.match(
    workflow,
    /needs.quality.result == 'success' && needs.macos-sign.result == 'success'/,
  );
  assert.match(workflow, /id-token: write/);
  assert.match(
    workflow,
    /if: vars.NIGHTLY_FEED_ROLE_ARN == ''\n.*run: echo 'Nightly feed upload skipped/,
  );
  assert.equal((workflow.match(/if: vars.NIGHTLY_FEED_ROLE_ARN != ''/g) ?? []).length, 2);
  assert.match(workflow, /role-to-assume: \$\{\{ vars.NIGHTLY_FEED_ROLE_ARN \}\}/);
  assert.doesNotMatch(workflow, /secrets\.|environment:|aws-access-key-id|aws-secret-access-key/);
});

test("stable names, bytes, checksums and manifest agree with immutable tested packages", () => {
  const result = objects();
  const downloads = result.filter((o) => o.filename);
  assert.deepEqual(
    downloads.map((o) => o.key.split("/").at(-1)),
    [
      "Foom-nightly-darwin-arm64.dmg",
      "Foom-nightly-darwin-arm64.zip",
      "Foom-nightly-linux-x64.deb",
      "Foom-nightly-linux-x64.rpm",
      "Foom-nightly-linux-x64.zip",
      "Foom-nightly-win32-x64-setup.exe",
      "Foom-nightly-win32-x64.zip",
    ],
  );
  const manifest = JSON.parse(
    result.find((o) => o.key === "updates/nightly/download/latest.json").data,
  );
  assert.deepEqual(
    [manifest.version, manifest.commit, manifest.commitDate],
    [info.version, info.sha, info.date],
  );
  let sums = "";
  for (const [index, download] of downloads.entries()) {
    const archive = result.find((o) => o.immutable && o.key.endsWith(`/${download.filename}`));
    assert.deepEqual(download.data, archive.data);
    const sha256 = createHash("sha256").update(download.data).digest("hex");
    const name = download.key.split("/").at(-1);
    assert.deepEqual(manifest.files[index], {
      name,
      sha256,
      url: `https://foom-term.com/${archive.key}`,
    });
    sums += `${sha256}  ${name}\n`;
  }
  assert.equal(result.find((o) => o.key.endsWith("/SHA256SUMS")).data.toString(), sums);
  const { calls, aws } = fakeAws();
  uploadFeed(result, config, aws);
  assert.deepEqual(
    calls.filter((a) => a[1] === "put-object").map((a) => a[a.indexOf("--key") + 1]),
    result.map((o) => o.key),
  );
  for (const download of downloads) {
    const put = calls.find((a) => a[1] === "put-object" && a.includes(download.key));
    assert.equal(
      put[put.indexOf("--content-disposition") + 1],
      `attachment; filename="${download.filename}"`,
    );
    assert.ok(put.includes("no-cache,max-age=0,must-revalidate"));
    assert.ok(put.includes("application/octet-stream"));
  }
});

test("every failed write stops publication; metadata only references uploaded immutable objects; retry repairs", () => {
  for (const failed of objects()) {
    const existing = new Map();
    const fixture = fakeAws({ existing, failPut: failed.key });
    assert.throws(() => uploadFeed(objects(), config, fixture.aws), /upload failed/);
    const position = objects().findIndex((o) => o.key === failed.key);
    assert.deepEqual(
      [...existing.keys()],
      objects()
        .slice(0, position)
        .map((o) => o.key),
    );
    assert.ok(!fixture.calls.some((a) => a[1] === "create-invalidation"));
    for (const object of existing.values()) {
      if (!object.key.endsWith(".json")) continue;
      const metadata = JSON.parse(object.data);
      for (const url of metadata.files?.map((file) => file.url) ?? [metadata.url]) {
        assert.ok(existing.has(url.replace("https://foom-term.com/", "")));
      }
    }
    uploadFeed(objects(), config, fakeAws({ existing }).aws);
    assert.equal(existing.size, objects().length);
  }
});

test("all JSON pointers refuse older, equal-time and same-day-earlier commits before any write", () => {
  for (const pointer of objects().filter((o) => o.key.endsWith(".json"))) {
    for (const date of ["2026-10-24T00:00:00Z", info.date, "2026-10-23T01:00:01Z"]) {
      const data = Buffer.from(JSON.stringify({ commit: "b".repeat(40), commitDate: date }));
      const fixture = fakeAws({ existing: new Map([[pointer.key, { ...pointer, data }]]) });
      assert.throws(() => uploadFeed(objects(), config, fixture.aws), /backwards/);
      assert.ok(!fixture.calls.some((a) => a[1] === "put-object"));
    }
  }
});

function publication(commit, date) {
  const next = identity(commit.repeat(40), date, "0.1.0");
  return generateFeed(
    packages.map(({ name, data }) => ({
      name: name.replace(`${info.day}-${info.short}`, `${next.day}-${next.short}`),
      data: Buffer.concat([data, Buffer.from(commit)]),
    })),
    next,
  );
}

test("interrupted newer downloads refuse a queued older commit before any write; same-commit retry repairs", () => {
  const baseline = publication("c", "2026-10-23T00:00:00Z");
  const older = publication("a", "2026-10-23T01:00:00Z");
  const newer = publication("b", "2026-10-23T02:00:00Z");
  const manifestKey = "updates/nightly/download/latest.json";
  const existing = new Map();
  uploadFeed(baseline, config, fakeAws({ existing, expected: baseline }).aws);
  const interrupted = fakeAws({ existing, expected: newer, failPut: manifestKey });
  assert.throws(() => uploadFeed(newer, config, interrupted.aws), /upload failed/);
  // Every JSON pointer still describes P, while every fixed file describes B.
  for (const object of baseline.filter((o) => !o.immutable && o.key.endsWith(".json"))) {
    assert.deepEqual(existing.get(object.key).data, object.data);
  }
  const fixed = newer.filter((o) => !o.immutable && !o.key.endsWith(".json"));
  assert.equal(fixed.length, 8);
  for (const object of fixed) {
    assert.deepEqual(existing.get(object.key).data, object.data);
    assert.equal(existing.get(object.key).metadata.commit, "b".repeat(40));
    assert.equal(existing.get(object.key).metadata.commitdate, "2026-10-23T02:00:00Z");
  }
  const before = new Map(existing);
  const queued = fakeAws({ existing, expected: older });
  assert.throws(() => uploadFeed(older, config, queued.aws), /backwards/);
  assert.ok(!queued.calls.some((a) => ["put-object", "create-invalidation"].includes(a[1])));
  assert.deepEqual(existing, before);
  const retry = fakeAws({ existing, expected: newer });
  uploadFeed(newer, config, retry.aws);
  assert.equal(retry.calls.filter((a) => a[1] === "put-object").length, 12);
  assert.equal(retry.calls.filter((a) => a[1] === "create-invalidation").length, 1);
  for (const object of newer) assert.deepEqual(existing.get(object.key).data, object.data);
});

test("each fixed object's HEAD identity independently blocks older/equal-time commits and invalid metadata", () => {
  for (const object of objects().filter((o) => !o.immutable && !o.key.endsWith(".json"))) {
    for (const commitdate of [info.date, "2026-10-23T01:00:01Z", "2026-10-24T00:00:00Z"]) {
      const fixture = fakeAws({
        existing: new Map([
          [
            object.key,
            {
              ...object,
              metadata: { sha256: object.sha256, commit: "b".repeat(40), commitdate },
            },
          ],
        ]),
      });
      assert.throws(() => uploadFeed(objects(), config, fixture.aws), /backwards/);
      assert.ok(!fixture.calls.some((a) => a[1] === "put-object"));
    }
    for (const metadata of [
      {},
      { commit: info.sha, commitdate: "invalid" },
      { commit: "bad", commitdate: info.date },
    ]) {
      const fixture = fakeAws({ existing: new Map([[object.key, { ...object, metadata }]]) });
      assert.throws(() => uploadFeed(objects(), config, fixture.aws), /Invalid existing/);
      assert.ok(!fixture.calls.some((a) => a[1] === "put-object"));
    }
  }
});

test("same-commit retry repairs fixed files split between the baseline and an interrupted newer commit", () => {
  const baseline = publication("c", "2026-10-23T00:00:00Z");
  const newer = publication("b", "2026-10-23T02:00:00Z");
  const existing = new Map();
  uploadFeed(baseline, config, fakeAws({ existing, expected: baseline }).aws);
  const interrupted = fakeAws({
    existing,
    expected: newer,
    failPut: "updates/nightly/download/Foom-nightly-linux-x64.rpm",
  });
  assert.throws(() => uploadFeed(newer, config, interrupted.aws), /upload failed/);
  const fixed = newer.filter((o) => !o.immutable && !o.key.endsWith(".json"));
  assert.deepEqual(
    new Set(fixed.map((o) => existing.get(o.key).metadata.commit)),
    new Set(["b".repeat(40), "c".repeat(40)]),
  );
  const retry = fakeAws({ existing, expected: newer });
  uploadFeed(newer, config, retry.aws);
  for (const object of newer) assert.deepEqual(existing.get(object.key).data, object.data);
  assert.equal(retry.calls.filter((a) => a[1] === "put-object").length, 12);
  assert.equal(retry.calls.filter((a) => a[1] === "create-invalidation").length, 1);
});
