import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

// Keep the temporary config beside the real config so relative plugin paths and
// ignores resolve identically. Both runs start fresh processes without a cache.
const temporary = `.oxlint-benchmark-${process.pid}.json`;
const config = JSON.parse(readFileSync(".oxlintrc.json", "utf8"));
const measurements = [];
try {
  for (const typeAware of [false, true]) {
    config.options.typeAware = typeAware;
    writeFileSync(temporary, JSON.stringify(config));
    const start = performance.now();
    const result = spawnSync(
      process.execPath,
      ["node_modules/oxlint/bin/oxlint", ".", "--config", temporary, "--deny-warnings"],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    measurements.push({ typeAware, milliseconds: Math.round(performance.now() - start) });
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
  console.info("Oxlint cold-process benchmark:", JSON.stringify(measurements));
} finally {
  rmSync(temporary, { force: true });
}
