const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const measurementPrefix = "SQLITE_MEASUREMENT ";
const workload = {
  coldStartSamples: 10,
  writeSamples: 50,
  warmupWritesPerProcess: 2,
  measuredWritesPerProcess: 5,
  repositories: 1000,
  pageSize: 100,
};

// #1285: Enable the approved platform/metric pairs when SQLite ships in phase B/C.
// See docs/areas/data.md.
const ENFORCE_SQLITE_VIEW_BUDGETS = false;

function measurementBudgets(platform) {
  return {
    coldStartToFirstView: {
      p95Ms: 500,
      enforced: platform === "linux" && ENFORCE_SQLITE_VIEW_BUDGETS,
    },
    writeToView: {
      p95Ms: 25,
      enforced: (platform === "linux" || platform === "darwin") && ENFORCE_SQLITE_VIEW_BUDGETS,
    },
  };
}

function assertSamples(metric, values, count) {
  assert.ok(Array.isArray(values), `Missing SQLite ${metric} samples`);
  assert.equal(values.length, count, `Wrong SQLite ${metric} sample count`);
  for (const value of values) {
    assert.ok(Number.isFinite(value) && value >= 0, `Invalid SQLite ${metric} sample`);
  }
}

async function runMeasurementChild(file, args, options) {
  const start = performance.timeOrigin + performance.now();
  const { stdout } = await execFileAsync(file, args, options);
  const line = stdout.split("\n").find((line) => line.startsWith(measurementPrefix));
  assert.ok(line, "Missing SQLite measurement result");
  const measured = JSON.parse(line.slice(measurementPrefix.length));
  assert.ok(Number.isFinite(measured?.firstViewAt), "Invalid SQLite first-view timestamp");
  assertSamples(
    "child writeToView",
    measured.writeToViewMs,
    workload.warmupWritesPerProcess + workload.measuredWritesPerProcess,
  );
  return {
    coldStartMs: measured.firstViewAt - start,
    writeToViewMs: measured.writeToViewMs.slice(workload.warmupWritesPerProcess),
  };
}

function measurementReport(samples, budgets) {
  assert.ok(budgets && Object.keys(budgets).length === 2, "Invalid SQLite measurement budgets");
  const report = { budgets: {} };
  for (const [metric, count] of [
    ["coldStartToFirstView", workload.coldStartSamples],
    ["writeToView", workload.writeSamples],
  ]) {
    const budget = budgets[metric];
    assert.ok(
      budget &&
        Object.keys(budget).length === 2 &&
        Number.isFinite(budget.p95Ms) &&
        budget.p95Ms > 0 &&
        typeof budget.enforced === "boolean",
      `Invalid SQLite ${metric} budget`,
    );
    const values = samples[metric];
    assertSamples(metric, values, count);
    const sorted = [...values].sort((a, b) => a - b);
    const p95Ms = sorted[Math.ceil(count * 0.95) - 1];
    report[metric] = {
      p50Ms: sorted[Math.ceil(count * 0.5) - 1],
      p95Ms,
      samplesMs: values,
    };
    report.budgets[metric] = { ...budget, gapMs: p95Ms - budget.p95Ms };
  }
  return report;
}

function assertMeasurementBudgets(platform, report) {
  for (const [metric, budget] of Object.entries(report.budgets)) {
    if (budget.enforced) {
      const measured = report[metric].p95Ms;
      assert.ok(
        measured <= budget.p95Ms,
        `SQLite ${metric} on ${platform}: measured p95 ${measured} ms exceeds approved p95 budget ${budget.p95Ms} ms`,
      );
    }
  }
}

module.exports = {
  assertMeasurementBudgets,
  measurementBudgets,
  measurementReport,
  runMeasurementChild,
  workload,
};
