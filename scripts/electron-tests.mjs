import { mkdirSync, writeFileSync } from "node:fs";
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
const outcome = {
  status: result.status,
  statusHex:
    result.status === null ? null : `0x${(result.status >>> 0).toString(16).padStart(8, "0")}`,
  signal: result.signal,
  error: result.error?.message,
};
writeFileSync(
  `test-results/${packaged ? "packaged" : "electron"}-runner.json`,
  JSON.stringify(outcome, null, 2),
);
console.info("Electron test runner outcome:", outcome);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
