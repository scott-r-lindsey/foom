import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { buildFingerprint, fingerprint } from "./validation-fingerprint.mjs";
const args = process.argv.slice(2);
const packaged = args.includes("--packaged");
const reuse = args.includes("--reuse-build");
const forwarded = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--packaged" || arg === "--reuse-build") continue;
  const value =
    arg === "--test-name-pattern"
      ? args[++index]
      : arg.startsWith("--test-name-pattern=")
        ? arg.slice("--test-name-pattern=".length)
        : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Invalid or unsupported option: ${arg}`);
  new RegExp(value); // Fail before building for malformed regular expressions.
  forwarded.push(`--test-name-pattern=${value}`);
}
if (packaged && reuse) throw new Error("--reuse-build is only for development Electron tests");
mkdirSync("test-results", { recursive: true });
const receipt = "test-results/electron-build.json";
if (!packaged) {
  const inputs = buildFingerprint();
  if (reuse) {
    let saved;
    try {
      saved = JSON.parse(readFileSync(receipt, "utf8"));
    } catch {
      throw new Error("No verified build. Run pnpm run test:electron without --reuse-build first.");
    }
    if (saved.inputs !== inputs || saved.output !== fingerprint(["build"])) {
      throw new Error("Stale build. Run pnpm run test:electron without --reuse-build.");
    }
    console.info("Reusing verified current Electron build.");
  } else {
    rmSync(receipt, { force: true });
    const build = spawnSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
    if (build.error) throw build.error;
    if (build.status !== 0) process.exit(build.status ?? 1);
    if (buildFingerprint() !== inputs)
      throw new Error("Build inputs changed during build; run again.");
    writeFileSync(receipt, JSON.stringify({ inputs, output: fingerprint(["build"]) }));
  }
}
const summaryPath = `test-results/${packaged ? "packaged" : "electron"}-summary.json`;
rmSync(summaryPath, { force: true });
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
    "--test-reporter=./scripts/electron-summary.mjs",
    `--test-reporter-destination=${summaryPath}`,
    // Keep Node options before the suite glob when #486 splits the suite.
    ...forwarded,
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

if (result.status === 0 && forwarded.length > 0) {
  const counts = JSON.parse(readFileSync(summaryPath, "utf8"));
  if (counts.passed === 0) {
    console.error("No selected tests passed. Check --test-name-pattern and FOOM_ELECTRON_SHARD.");
    process.exitCode = 1;
  } else console.info(`Focused validation: ${counts.passed} selected tests passed.`);
}
