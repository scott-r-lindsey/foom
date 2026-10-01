import { describe, expect, test } from "vitest";
import { reportChangedCoverage } from "../../../scripts/report-changed-coverage.mjs";

const lcov = `TN:
SF:src/example.ts
DA:2,3
DA:3,0
DA:4,0
DA:8,1
LF:4
LH:2
end_of_record
`;

describe("reportChangedCoverage", () => {
  test("reports and annotates covered and uncovered changed ranges", () => {
    const diff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,0 +2,3 @@
@@ -7,0 +8 @@
`;

    const report = reportChangedCoverage(lcov, diff);

    expect(report).toMatchObject({ covered: 2, total: 4 });
    expect(report.markdown).toContain("2 of 4 changed executable lines are covered (50%).");
    expect(report.markdown).toContain("`src/example.ts:3-4`");
    expect(report.commands).toContain(
      "::notice file=src/example.ts,line=2,endLine=2,title=Covered by tests::Changed executable lines are covered.",
    );
    expect(report.commands).toContain(
      "::warning file=src/example.ts,line=3,endLine=4,title=Not covered by tests::Changed executable lines are not covered.",
    );
  });

  test("ignores changed lines that are not executable according to LCOV", () => {
    const diff = `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -9,0 +10,2 @@
`;

    const report = reportChangedCoverage(lcov, diff);

    expect(report).toMatchObject({ commands: [], covered: 0, total: 0 });
    expect(report.markdown).toContain("No changed executable lines appear in the LCOV report.");
  });
});

test("fails below the changed-line coverage threshold", () => {
  const report = reportChangedCoverage(lcov, "+++ b/src/example.ts\n@@ -1,0 +2,3 @@\n");
  expect(report.passed).toBe(false);
  expect(report.markdown).toContain("**Failed**");
});

test("passes when all changed executable lines are covered", () => {
  expect(reportChangedCoverage(lcov, "+++ b/src/example.ts\n@@ -1,0 +2 @@\n").passed).toBe(true);
});

test("fails closed when a changed application file is absent from LCOV", () => {
  const report = reportChangedCoverage("", "+++ b/src/untested.ts\n@@ -0,0 +1,3 @@\n");
  expect(report.passed).toBe(false);
  expect(report.missingFiles).toEqual(["src/untested.ts"]);
  expect(report.commands[0]).toContain("::error");
});

test("does not require coverage for declarations, type-only bridge contract, or tooling", () => {
  const diff = ["src/renderer/global.d.ts", "src/shared/desktop.d.ts", "scripts/build.mjs"]
    .map((path) => `+++ b/${path}\n@@ -0,0 +1,3 @@\n`)
    .join("");
  expect(reportChangedCoverage("", diff).passed).toBe(true);
});

test("ignores deleted files and zero-length added hunks", () => {
  expect(reportChangedCoverage("", "+++ /dev/null\n@@ -1,3 +0,0 @@\n").passed).toBe(true);
  expect(reportChangedCoverage("", "+++ b/src/deleted-lines.ts\n@@ -1,3 +1,0 @@\n").passed).toBe(
    true,
  );
});
