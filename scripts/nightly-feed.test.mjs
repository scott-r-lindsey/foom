import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { generateFeed, uploadFeed } from "./nightly-feed.mjs";
import { identity } from "./nightly.mjs";

const info = identity("a".repeat(40), "2026-10-23T01:00:00Z", "0.1.0");
const zip = Buffer.from([0x50, 0x4b, 3, 4, 1]);
const packages = ["darwin-arm64", "linux-x64", "win32-x64"].map((target) => ({
  name: `Foom-nightly-${info.day}-${info.short}-${target}.zip`,
  data: zip,
}));
const config = { bucket: "example-site", distribution: "EXAMPLE123", region: "us-east-1" };
const objects = () => generateFeed([...packages, { name: "test-RELEASES", data: zip }], info);

test("feed paths and immutable URLs bind version, full commit, architecture and checksum", () => {
  const result = objects();
  assert.equal(result.length, 6);
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
    assert.equal(feed.sha256, createHash("sha256").update(zip).digest("hex"));
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
  }
});
test("generator rejects missing, duplicate, invalid or path-escaping artifacts and stale identity", () => {
  for (const input of [
    packages.slice(1),
    [...packages, packages[0]],
    [...packages, { name: "../evil", data: zip }],
    packages.map((p) => ({ ...p, data: Buffer.from("not zip") })),
    packages.map((p) => ({ ...p, data: Buffer.alloc(0) })),
  ])
    assert.throws(() => generateFeed(input, info));
  assert.throws(() => generateFeed(packages, { ...info, version: "0.2.0" }));
});
function fakeAws({ existing = new Map(), failPut, failHead } = {}) {
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
        Metadata: { sha256: value.sha256 },
        ContentLength: value.data.length,
      });
    }
    if (args[1] === "get-object") {
      writeFileSync(args[args.indexOf("--region") - 1], value.data);
      return "{}";
    }
    if (args[1] === "put-object") {
      if (key === failPut) throw new Error("upload failed");
      assert.deepEqual(
        readFileSync(args[args.indexOf("--body") + 1]),
        objects().find((o) => o.key === key).data,
      );
    }
    return "{}";
  };
  return { calls, aws };
}
test("uploads all immutable bytes conditionally before feeds, invalidates exact metadata paths only", () => {
  const { calls, aws } = fakeAws();
  uploadFeed(objects(), config, aws);
  const puts = calls.filter((a) => a[1] === "put-object");
  assert.equal(puts.length, 6);
  assert.equal(
    puts.slice(0, 3).every((a) => a.includes("--if-none-match") && a.includes("*")),
    true,
  );
  assert.equal(
    puts.slice(3).some((a) => a.includes("--if-none-match")),
    false,
  );
  assert.deepEqual(calls.at(-1).slice(0, -3), [
    "cloudfront",
    "create-invalidation",
    "--distribution-id",
    config.distribution,
    "--paths",
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
  assert.equal(fixture.calls.filter((a) => a[1] === "put-object").length, 3);
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
  const feed = objects()[3];
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
  const feed = objects()[3];
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
