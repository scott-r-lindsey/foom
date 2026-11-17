import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readAudit, runAudit, validateAudit } from "./audit.mjs";

const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const all = load("../tests/fixtures/audit/development.json");
const prod = load("../tests/fixtures/audit/production.json");
const exceptions = load("./audit-exceptions.json");
const now = new Date("2026-11-17T00:00:00Z");
const finding = (report) => Object.values(report.advisories)[0];
const check = (report = all, production = prod, entries = exceptions, date = now) =>
  validateAudit(report, production, entries, date);

test("recorded development-only advisory passes and both audit scopes are requested", () => {
  check();
  check(all, prod, exceptions, new Date("2026-12-01T23:59:59.999Z"));
  check(prod, prod, []);
  const calls = [];
  runAudit((args) => {
    calls.push(args);
    return args.length ? prod : all;
  }, now);
  assert.deepEqual(calls, [[], ["--prod"]]);
});

test("expiry, invalid clock, stale exception and production exposure fail closed", () => {
  assert.throws(() => check(all, prod, exceptions, new Date("2026-12-02")), /expired exception/);
  assert.throws(() => check(all, prod, exceptions, new Date(NaN)), /expired exception/);
  assert.throws(() => check(prod), /stale exception/);
  assert.throws(() => check(all, all), /exception found in production/);
});

test("every advisory must be excepted in either scope, including additional findings", () => {
  assert.throws(() => check(all, prod, []), /unexcepted advisory/);
  const extra = structuredClone(all);
  const entry = structuredClone(finding(all));
  entry.github_advisory_id = "GHSA-xxxx-xxxx-xxxx";
  extra.advisories.other = entry;
  extra.metadata.vulnerabilities.high++;
  assert.throws(() => check(extra), /unexcepted advisory/);
  const otherProd = structuredClone(extra);
  delete otherProd.advisories[Object.keys(all.advisories)[0]];
  otherProd.metadata.vulnerabilities.high--;
  assert.throws(() => check(all, otherProd), /unexcepted advisory/);
});

test("every matching finding must retain the exact package/range and have no patch", () => {
  for (const [field, value] of [
    ["module_name", "other"],
    ["vulnerable_versions", "<=5.0.0"],
    ["patched_versions", ">=4.0.8"],
  ]) {
    const report = structuredClone(all);
    report.advisories.other = { ...structuredClone(finding(all)), [field]: value };
    report.metadata.vulnerabilities.high++;
    assert.throws(() => check(report), /does not match an unpatched advisory/);
  }
});

test("malformed, duplicate and unknown-field exceptions are rejected", () => {
  for (const entries of [null, {}, [null], [exceptions[0], exceptions[0]]])
    assert.throws(() => check(all, prod, entries), /malformed exception/);
  for (const [field, value] of [
    ["ghsa", "*"],
    ["cve", "invalid"],
    ["upstreamFix", "https://example.com"],
    ["package", ""],
    ["vulnerableVersions", null],
    ["expires", "2026-02-30"],
    ["expires", "tomorrow"],
    ["expires", 1],
    ["issue", 0],
    ["issue", "1249"],
    ["justification", " "],
    ["unknown", true],
  ]) {
    assert.throws(
      () => check(all, prod, [{ ...exceptions[0], [field]: value }]),
      /malformed exception/,
    );
  }
  for (const field of Object.keys(exceptions[0])) {
    const entry = { ...exceptions[0] };
    delete entry[field];
    assert.throws(() => check(all, prod, [entry]), /malformed exception/);
  }
});

test("malformed audit reports never hide advisories or registry errors", () => {
  for (const report of [
    null,
    {},
    { ...prod, error: "registry" },
    { ...prod, muted: ["hidden"] },
    { ...prod, metadata: {} },
    { ...all, advisories: {} },
  ])
    assert.throws(() => check(report), /invalid audit report/);
  for (const [field, value] of [
    ["github_advisory_id", "invalid"],
    ["module_name", ""],
    ["vulnerable_versions", null],
    ["findings", []],
    ["findings", [{ version: "4.0.7", paths: [] }]],
    ["findings", [{ version: "", paths: ["path"] }]],
  ]) {
    const report = structuredClone(all);
    finding(report)[field] = value;
    assert.throws(() => check(report), /invalid audit report/);
  }
  for (const source of [all, prod]) {
    const renamed = structuredClone(source);
    const { high, ...rest } = renamed.metadata.vulnerabilities;
    renamed.metadata.vulnerabilities = { ...rest, unrecognized: high };
    const extra = structuredClone(source);
    extra.metadata.vulnerabilities.unrecognized = 0;
    for (const report of [renamed, extra])
      assert.throws(
        () => (source === all ? check(report) : check(all, report)),
        /invalid audit report/,
      );
  }
});

test("audit command uses argument arrays, low threshold, JSON and explicit production scope", () => {
  const execute = (file, args, options) => {
    assert.equal(file, process.execPath);
    assert.deepEqual(args, ["/fixture/pnpm.cjs", "audit", "--json", "--audit-level=low", "--prod"]);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    return JSON.stringify(prod);
  };
  assert.deepEqual(readAudit(["--prod"], execute, "/fixture/pnpm.cjs"), prod);
});

test("command failures, invalid JSON and empty failure reports fail with fixed messages", () => {
  const run = (execute) => readAudit([], execute, "/fixture/pnpm.cjs");
  assert.deepEqual(
    run(() => {
      throw { status: 1, stdout: JSON.stringify(all) };
    }),
    all,
  );
  for (const error of [
    { status: 2, stdout: JSON.stringify(all) },
    { status: 1, stdout: JSON.stringify(prod) },
    new Error("SECRET"),
  ])
    assert.throws(
      () =>
        run(() => {
          throw error;
        }),
      { message: "Audit failed: audit command failed." },
    );
  assert.throws(() => run(() => "broken SECRET"), {
    message: "Audit failed: invalid audit report.",
  });
  assert.throws(
    () =>
      run(() => {
        throw { status: 1, stdout: "SECRET" };
      }),
    { message: "Audit failed: invalid audit report." },
  );
  assert.throws(() => readAudit([], () => "", ""), /run with pnpm run audit/);
});

test("standalone pnpm executables run directly rather than through Node", () => {
  const execute = (file, args) => {
    assert.equal(file, "/fixture/pnpm");
    assert.deepEqual(args, ["audit", "--json", "--audit-level=low"]);
    return JSON.stringify(prod);
  };
  assert.deepEqual(readAudit([], execute, "/fixture/pnpm"), prod);
});
