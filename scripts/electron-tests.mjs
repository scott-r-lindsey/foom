import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  checkoutRevision,
  digest,
  hostPlatforms,
  verifyHostArtifact,
} from "./remote-host-artifacts.mjs";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  BuildInputChanged,
  buildEnvironmentFingerprint,
  buildOutputFingerprint,
  buildFileDigest,
  matchesBuildInputs,
  readBuildFile,
} from "./validation-fingerprint.mjs";
import { suiteFiles } from "../tests/electron/test-suites.js";
import { guardWorktreeWrites } from "../tests/helpers/worktree-writes.js";
const checkWorktreeWrites = guardWorktreeWrites();
const args = process.argv.slice(2);
const packaged = args.includes("--packaged");
const requireReuse = args.includes("--reuse-build");
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
if (packaged && requireReuse)
  throw new Error("--reuse-build is only for development Electron tests");
mkdirSync("test-results", { recursive: true });
const receipt = "test-results/electron-build.json";

function recordBuild(staging, environment, catalog, revision, processes) {
  try {
    const snapshots = readdirSync(staging).map((name) =>
      JSON.parse(readBuildFile(join(staging, name)).toString("utf8")),
    );
    if (snapshots.some((snapshot) => snapshot.changed === true))
      throw new BuildInputChanged("Build inputs changed during Electron preparation; run again.");
    if (
      processes.some((pid) => !lstatSync(join(staging, `${pid}.json`)).isFile()) ||
      snapshots.some((snapshot) => snapshot.valid !== true)
    )
      return;
    const snapshot = {};
    for (const key of ["inputs", "directories", "manifests", "lookups"]) {
      const entries = new Map();
      for (const part of snapshots) {
        for (const [path, hash] of part[key]) {
          if (entries.has(path) && entries.get(path) !== hash)
            throw new BuildInputChanged(
              "Build inputs changed during Electron preparation; run again.",
            );
          entries.set(path, hash);
        }
      }
      snapshot[key] = [...entries];
    }
    let matches;
    try {
      matches = matchesBuildInputs(snapshot);
    } catch {
      // A file read successfully during the build is no longer readable.
      matches = false;
    }
    if (!matches)
      throw new BuildInputChanged("Build inputs changed during Electron preparation; run again.");
    const output = buildOutputFingerprint();
    const pending = join(staging, "receipt");
    writeFileSync(pending, JSON.stringify({ environment, catalog, revision, output, snapshot }));
    renameSync(pending, receipt);
  } catch (error) {
    if (error instanceof BuildInputChanged) throw error;
    // A fresh build can run the tests even when its output cannot be reused.
    console.warn(
      "Electron build receipt unavailable.",
      error instanceof Error ? error.message : error,
    );
  }
}

function buildEnvironment() {
  try {
    return buildEnvironmentFingerprint();
  } catch {
    return undefined;
  }
}

function isCI() {
  const env = process.env;
  return env.CI || env.GITHUB_ACTIONS || env.FOOM_CI_ELECTRON_SUITES !== undefined;
}

function defaultCatalogFingerprint() {
  const env = process.env;
  // Other catalog policies require the build to validate their inputs.
  if (
    env.FOOM_PACKAGE === "1" ||
    env.FOOM_REQUIRE_REMOTE_HOSTS === "1" ||
    env.FOOM_REMOTE_HOST_ARTIFACTS !== undefined
  )
    return undefined;
  const files = hostPlatforms.flatMap((target) =>
    ["manifest.json", "foom-host.gz"].map((name) => join(".cache/remote-hosts", target, name)),
  );
  try {
    const entries = files.map((file) => lstatSync(file, { throwIfNoEntry: false }));
    // The app omits the entire default catalog if any required file is missing.
    if (entries.some((entry) => entry === undefined)) return null;
    if (entries.some((entry) => !entry.isFile() || entry.size > 200 * 1024 * 1024))
      return undefined;
    return files.map((file) => buildFileDigest(resolve(file))).join(":");
  } catch {
    // Without a readable snapshot, build fresh and leave no reusable receipt.
    return undefined;
  }
}

function matchesReceipt(environment, catalog, revision) {
  try {
    const saved = JSON.parse(readBuildFile(receipt).toString("utf8"));
    return (
      saved?.environment === environment &&
      saved.catalog === catalog &&
      saved.revision === revision &&
      matchesBuildInputs(saved.snapshot) &&
      saved.output === buildOutputFingerprint()
    );
  } catch {
    // A missing, malformed or unreadable receipt or build cannot prove reuse.
    return false;
  }
}

function runBuild(script, args, env) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", env });
  if (result.error) throw result.error;
  return result;
}

if (!packaged) {
  const revision = checkoutRevision(process.cwd());
  // An override can load executable code with inputs outside the fingerprint.
  const override = ["ESBUILD_BINARY_PATH", "NODE_OPTIONS", "NODE_PATH"].find(
    (name) => process.env[name] !== undefined,
  );
  if (override && requireReuse)
    throw new Error(`${override} requires a fresh build. Run without --reuse-build.`);
  const catalog = defaultCatalogFingerprint();
  const trackBuild = !override && catalog !== undefined && !isCI();
  // Electron may install its binary on first require.
  if (trackBuild && !requireReuse) createRequire(import.meta.url)("electron");
  const environment = trackBuild || requireReuse ? buildEnvironment() : undefined;
  const reuse =
    environment !== undefined &&
    catalog !== undefined &&
    matchesReceipt(environment, catalog, revision);
  if (requireReuse && !reuse)
    throw new Error("No current verified build. Run pnpm run test:electron without --reuse-build.");
  const env = { ...process.env };
  delete env.FOOM_BUILD_INPUTS;
  const canRecord = !reuse && trackBuild && environment !== undefined;
  const staging = canRecord ? mkdtempSync(resolve("test-results/electron-inputs-")) : undefined;
  if (staging) {
    env.FOOM_BUILD_INPUTS = staging;
    env.NODE_OPTIONS = `--import=${new URL("./build-inputs.mjs", import.meta.url).href}`;
  }
  const processes = [];
  try {
    if (reuse) {
      console.info("Reusing verified current Electron build.");
    } else {
      if (!lstatSync(receipt, { throwIfNoEntry: false })?.isDirectory())
        rmSync(receipt, { force: true });
      const build = runBuild("scripts/build.mjs", [], env);
      if (build.status !== 0) {
        if (staging) rmSync(staging, { recursive: true, force: true });
        process.exit(build.status ?? 1);
      }
      processes.push(build.pid);
    }
    if (process.platform !== "win32") {
      if (!reuse) {
        delete env.FOOM_REMOTE_HOST_OUTPUT;
        delete env.FOOM_REMOTE_HOST_INPUTS_OUTPUT;
        const host = runBuild("scripts/build-remote-host.mjs", ["--fixture-resources"], env);
        if (host.status !== 0) {
          if (staging) rmSync(staging, { recursive: true, force: true });
          process.exit(host.status ?? 1);
        }
        processes.push(host.pid);
      }
      const { version } = JSON.parse(readFileSync("package.json", "utf8"));
      const target = `${process.platform}-${process.arch}`;
      const { manifest } = await verifyHostArtifact("build/remote-host", target, version, revision);
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
        // The isolated test catalog intentionally contains only this platform's fixture.
        writeFileSync(
          "build/build-metadata.json",
          JSON.stringify({
            source: revision,
            remoteHostsAvailable: true,
          }),
        );
      }
    }
    if (
      (staging &&
        (buildEnvironment() !== environment || defaultCatalogFingerprint() !== catalog)) ||
      checkoutRevision(process.cwd()) !== revision
    )
      throw new BuildInputChanged("Build inputs changed during Electron preparation; run again.");
    if (staging) recordBuild(staging, environment, catalog, revision, processes);
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
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
