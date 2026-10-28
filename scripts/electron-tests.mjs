import assert from "node:assert/strict";
import { join } from "node:path";
import { checkoutRevision, digest, verifyHostArtifact } from "./remote-host-artifacts.mjs";
import { cpSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { buildFingerprint, fingerprint } from "./validation-fingerprint.mjs";
import { suiteFiles } from "../tests/electron/test-suites.js";
import { guardWorktreeWrites } from "../tests/helpers/worktree-writes.js";
const checkWorktreeWrites = guardWorktreeWrites();
const args = process.argv.slice(2);
const packaged = args.includes("--packaged");
const reuse = args.includes("--reuse-build");
const forwarded = [];
const selectedSuites = [];
const inventory = suiteFiles();
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--packaged" || arg === "--reuse-build") continue;
  if (arg.startsWith("--suite=")) {
    const name = arg.slice("--suite=".length);
    const suite = inventory.find((file) => file.endsWith(`/${name}`) || file.endsWith(`\\${name}`));
    if (!suite || !/^[a-z-]+\.test\.js$/.test(name)) throw new Error(`Unknown suite: ${name}`);
    selectedSuites.push(suite);
    continue;
  }
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
if (packaged && selectedSuites.length > 0)
  throw new Error("--suite is only for development Electron tests");
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
  }
  if (process.platform !== "win32") {
    if (!reuse) {
      const env = { ...process.env };
      delete env.FOOM_REMOTE_HOST_OUTPUT;
      delete env.FOOM_REMOTE_HOST_INPUTS_OUTPUT;
      const host = spawnSync(process.execPath, ["scripts/build-remote-host.mjs"], {
        stdio: "inherit",
        env,
      });
      if (host.error) throw host.error;
      if (host.status !== 0) process.exit(host.status ?? 1);
    }
    const { version } = JSON.parse(readFileSync("package.json", "utf8"));
    const target = `${process.platform}-${process.arch}`;
    const { manifest } = await verifyHostArtifact(
      "build/remote-host",
      target,
      version,
      checkoutRevision(process.cwd()),
    );
    assert.equal(
      digest(readFileSync("build/remote-host/foom-host")),
      manifest.sha256,
      "Remote fixture executable hash mismatch",
    );
    if (!reuse) {
      const catalog = join("build/remote-hosts", target);
      mkdirSync(catalog, { recursive: true });
      for (const name of ["foom-host.gz", "manifest.json"])
        cpSync(join("build/remote-host", name), join(catalog, name));
    }
  }
  if (!reuse) {
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
    // Native windows share focus and the desktop; never run feature files in parallel.
    "--test-concurrency=1",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=junit",
    `--test-reporter-destination=test-results/${packaged ? "packaged" : "electron"}.xml`,
    "--test-reporter=./scripts/electron-summary.mjs",
    `--test-reporter-destination=${summaryPath}`,
    // Node filters must precede every discovered suite.
    ...forwarded,
    ...(packaged
      ? ["tests/electron/packaged-smoke.js"]
      : selectedSuites.length > 0
        ? [...new Set(selectedSuites)].sort()
        : inventory),
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
try {
  checkWorktreeWrites();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
if (result.error) throw result.error;
process.exitCode ||= result.status ?? 1;

if (result.status === 0 && (forwarded.length > 0 || selectedSuites.length > 0)) {
  const counts = JSON.parse(readFileSync(summaryPath, "utf8"));
  if (counts.passed === 0) {
    console.error("No selected tests passed. Check --test-name-pattern and FOOM_ELECTRON_SHARD.");
    process.exitCode = 1;
  } else console.info(`Focused validation: ${counts.passed} selected tests passed.`);
}
