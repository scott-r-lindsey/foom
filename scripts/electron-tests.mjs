import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const packaged = process.argv.includes("--packaged");
mkdirSync("test-results", { recursive: true });
const result = spawnSync(
  process.execPath,
  [
    "--require",
    "./tests/helpers/setup.js",
    "--test",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=junit",
    `--test-reporter-destination=test-results/${packaged ? "packaged" : "electron"}.xml`,
    packaged ? "tests/electron/packaged-smoke.js" : "tests/electron/*.test.js",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
