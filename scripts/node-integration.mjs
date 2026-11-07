import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const directory = "test-results/node-integration";
await mkdir(directory, { recursive: true });
const start = performance.now();
await build({
  entryPoints: ["tests/integration/core.ts"],
  outfile: `${directory}/core.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  metafile: true,
}).then(async (result) => {
  if (Object.keys(result.metafile.inputs).some((file) => /(^|\/)electron(\/|$)/.test(file)))
    throw new Error("Electron in Node integration bundle");
  await writeFile(`${directory}/inputs.json`, JSON.stringify(result.metafile.inputs, null, 2));
});
await build({
  entryPoints: ["src/cli/main.ts"],
  outfile: `${directory}/cli.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  define: { FOOM_VERSION: '"0.1.0"' },
});
const built = performance.now();
const result = spawnSync(
  process.execPath,
  [
    "--require",
    "./tests/helpers/setup.js",
    "--require",
    "./tests/integration/no-electron.js",
    "--test",
    "--test-reporter=spec",
    "--test-reporter=junit",
    `--test-reporter-destination=stdout`,
    `--test-reporter-destination=${directory}/junit.xml`,
    "tests/integration/orchestration.test.js",
  ],
  { stdio: "inherit" },
);
const timings = {
  platform: process.platform,
  node: process.version,
  buildMs: built - start,
  testProcessMs: performance.now() - built,
  totalMs: performance.now() - start,
};
await writeFile(`${directory}/runner.json`, JSON.stringify(timings, null, 2));
console.log("Node integration timing:", JSON.stringify(timings));
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
