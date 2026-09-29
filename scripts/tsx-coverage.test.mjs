import { test } from "node:test";
import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import { parseLcov } from "./report-changed-coverage.mjs";

// Run after coverage generation, against the actual report, not a cached fixture.
test("every TSX source is present in the coverage report", async () => {
  const report = parseLcov(await readFile("coverage/lcov.info", "utf8"));
  for await (const file of glob("src/**/*.tsx")) {
    const normalized = file.replaceAll("\\", "/");
    assert.ok(report.has(normalized), `Missing TSX coverage: ${normalized}`);
  }
});
