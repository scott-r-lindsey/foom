import { expect, test } from "vitest";
import {
  assertMeasurementBudgets,
  measurementBudgets,
  measurementReport,
  runMeasurementChild,
} from "../electron/sqlite-measurements.js";

const samples = {
  coldStartToFirstView: Array<number>(10).fill(600),
  writeToView: [...Array<number>(47).fill(3), 48, 100, 200],
};

test.each(["linux", "darwin", "win32"])("SQLite budget gaps are report-only on %s", (platform) => {
  const report = measurementReport(samples, measurementBudgets(platform));
  expect(report).toMatchObject({
    coldStartToFirstView: { p50Ms: 600, p95Ms: 600, samplesMs: samples.coldStartToFirstView },
    writeToView: { p50Ms: 3, p95Ms: 48, samplesMs: samples.writeToView },
    budgets: {
      coldStartToFirstView: { p95Ms: 500, enforced: false, gapMs: 100 },
      writeToView: { p95Ms: 25, enforced: false, gapMs: 23 },
    },
  });
  expect(() => {
    assertMeasurementBudgets(platform, report);
  }).not.toThrow();
});

test("SQLite budget enforcement can fail an over-budget metric", () => {
  const budgets = measurementBudgets("linux");
  const report = measurementReport(samples, {
    ...budgets,
    writeToView: { ...budgets.writeToView, enforced: true },
  });
  expect(() => {
    assertMeasurementBudgets("linux", report);
  }).toThrow("SQLite writeToView on linux: measured p95 48 ms exceeds approved p95 budget 25 ms");
});

test("SQLite report-only measurements still require complete finite samples", () => {
  const budgets = measurementBudgets("linux");
  expect(() => measurementReport({ ...samples, coldStartToFirstView: [] }, budgets)).toThrow(
    "Wrong SQLite coldStartToFirstView sample count",
  );
  expect(() => measurementReport({ ...samples, writeToView: [3] }, budgets)).toThrow(
    "Wrong SQLite writeToView sample count",
  );
  expect(() => measurementReport({ ...samples, writeToView: undefined }, budgets)).toThrow(
    "Missing SQLite writeToView samples",
  );
  for (const value of [NaN, Infinity, null]) {
    expect(() =>
      measurementReport(
        { ...samples, writeToView: [value, ...samples.writeToView.slice(1)] },
        budgets,
      ),
    ).toThrow("Invalid SQLite writeToView sample");
  }
});

test("SQLite report-only measurements reject malformed budgets", () => {
  const budgets = measurementBudgets("linux");
  expect(() => measurementReport(samples, {})).toThrow("Invalid SQLite measurement budgets");
  for (const writeToView of [
    undefined,
    { p95Ms: 25 },
    { p95Ms: Infinity, enforced: false },
    { p95Ms: 0, enforced: false },
    { p95Ms: 25, enforced: "false" },
    { p95Ms: 25, enforced: false, extra: true },
  ]) {
    expect(() => measurementReport(samples, { ...budgets, writeToView })).toThrow(
      "Invalid SQLite writeToView budget",
    );
  }
});

test("SQLite measurement child drops warm-ups and retains all timed writes", async () => {
  const result = await runMeasurementChild(
    process.execPath,
    [
      "-e",
      'console.log("SQLITE_MEASUREMENT " + JSON.stringify({firstViewAt: performance.timeOrigin + performance.now(), writeToViewMs: [99, 98, 3, 4, 5, 6, 7]}))',
    ],
    {},
  );
  expect(result.coldStartMs).toBeGreaterThan(0);
  expect(result.writeToViewMs).toEqual([3, 4, 5, 6, 7]);
});

test.each([
  ["process.exitCode = 2", "Command failed"],
  ['console.log("no measurement")', "Missing SQLite measurement result"],
  ['console.log("SQLITE_MEASUREMENT null")', "Invalid SQLite first-view timestamp"],
  ['console.log("SQLITE_MEASUREMENT {}")', "Invalid SQLite first-view timestamp"],
  [
    'console.log(\'SQLITE_MEASUREMENT {"firstViewAt":1,"writeToViewMs":[0]}\')',
    "Wrong SQLite child writeToView sample count",
  ],
  [
    'console.log(\'SQLITE_MEASUREMENT {"firstViewAt":1,"writeToViewMs":[null,0,0,0,0,0,0]}\')',
    "Invalid SQLite child writeToView sample",
  ],
])("SQLite measurement child fails for %s", async (script, error) => {
  await expect(runMeasurementChild(process.execPath, ["-e", script], {})).rejects.toThrow(error);
});
