import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { balance, parseCases, readMeasurements, writePlan } from "./rebalance-electron-shards.mjs";

function fixture(t, xml) {
  const directory = mkdtempSync(join(tmpdir(), "foom-rebalance-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "123");
  const report = join(source, "electron-results-linux-0");
  mkdirSync(report, { recursive: true });
  writeFileSync(join(report, "electron.xml"), `<testsuites>${xml}</testsuites>`);
  return { source, read: (names = ["case"]) => readMeasurements([source], ["linux"], names, 1) };
}

const entry = (time, children = "") =>
  `<testcase name="case" file="/tests/test-shard.js" time="${time}">${children}</testcase>`;

test("JUnit names decode entities; Windows paths, skipped cases and placeholders retain their meaning", (t) => {
  const xml = `<?xml version="1.0"?>
    <!-- <testcase name="comment"/> -->
    <testcase name="a &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos; &#65; &#x1f680;" file="C:\\tests\\test-shard.js" time="2.123456"/>
    <testcase name="skip" file="/tests/test-shard.js" time="0.001"><skipped message="not here"/></testcase>
    <testcase name="/tests/empty.test.js" file="/tests/empty.test.js" time="0.5"/>
    <testcase name="removed case" file="/tests/test-shard.js" time="9"/>`;
  const name = `a & <b> "c" 'd' A 🚀`;
  const { read } = fixture(t, xml);
  assert.deepEqual(
    [...read([name, "skip"])],
    [
      [name, [2.123]],
      ["skip", [0]],
    ],
  );
});

test("reports reject duplicate and failed cases, including error elements", (t) => {
  for (const xml of [
    entry("1") + entry("2"),
    entry("1", "<failure><![CDATA[bad <result>]]></failure>"),
    entry("1", "<error/>"),
  ]) {
    assert.throws(() => fixture(t, xml).read(), /duplicate case|Failed case/);
  }
  const { source } = fixture(t, entry("1"));
  const other = join(source, "electron-results-linux-1");
  mkdirSync(other);
  writeFileSync(join(other, "electron.xml"), `<testsuites>${entry("2")}</testsuites>`);
  assert.throws(() => readMeasurements([source], ["linux"], ["case"], 2), /duplicate case/);
});

test("invalid durations, incomplete inputs and unsupported XML fail closed", (t) => {
  for (const value of ["", " ", "NaN", "Infinity", "-1", "0x10", "1e999"]) {
    assert.throws(() => fixture(t, entry(value)).read(), /Invalid duration/);
  }
  const { read, source } = fixture(t, entry("1"));
  assert.throws(() => read(["missing"]), /missing measurements/);
  assert.throws(() => readMeasurements([source], ["linux"], ["case"], 2), /Expected 2/);
  for (const xml of [
    "<testsuites>",
    "<testsuites></testcase>",
    '<!DOCTYPE test SYSTEM "https://invalid.example"><testsuites/>',
    '<testcase name="&unknown;"/>',
  ]) {
    assert.throws(() => parseCases(xml), /XML/);
  }
});

test("maxima across runs feed deterministic balancing and no-op writes preserve exact bytes", (t) => {
  const first = fixture(t, entry("1.1114"));
  const second = fixture(t, entry("2.2224"));
  assert.deepEqual(
    [...readMeasurements([first.source, second.source], ["linux"], ["case"], 1)],
    [["case", [2.222]]],
  );
  const durations = new Map([
    ["a", [1, 2, 3]],
    ["b", [2, 3, 4]],
    ["c", [4, 5, 6]],
  ]);
  const shards = balance(durations, 4);
  assert.deepEqual(balance(new Map([...durations].reverse()), 4), shards);
  assert.deepEqual(shards.flatMap(Object.keys).sort(), ["a", "b", "c"]);
  const path = join(first.source, "plan.json");
  const plan = { shards };
  const original = `${JSON.stringify(plan)}\n`;
  writeFileSync(path, original);
  writePlan(path, plan);
  assert.equal(readFileSync(path, "utf8"), original);
  writePlan(path, { shards: [] });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { shards: [] });
});
