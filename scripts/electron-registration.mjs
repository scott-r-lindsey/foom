import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./electron-registration-worker.cjs", import.meta.url));
const setupFile = fileURLToPath(new URL("../tests/helpers/setup.js", import.meta.url));
const discoveryTimeoutMs = 15_000;

export function discoverRegistrations(files, { shard, patterns = [] } = {}) {
  if (files.length === 0) return new Map();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  if (shard === undefined) delete env.FOOM_ELECTRON_SHARD;
  else env.FOOM_ELECTRON_SHARD = shard;

  const directory = mkdtempSync(join(tmpdir(), "foom-electron-registration-"));
  try {
    const setup = existsSync(setupFile)
      ? ["--require", `./${relative(process.cwd(), setupFile)}`]
      : [];
    const bridges = files.map((file, index) => {
      const entry = join(directory, `${index}.cjs`);
      const result = join(directory, `${index}.json`);
      writeFileSync(
        entry,
        `require(${JSON.stringify(worker)})(${JSON.stringify(resolve(file))}, ${JSON.stringify(result)}, ${JSON.stringify(patterns)});\n`,
      );
      return { file, entry, result };
    });
    const launcher = join(directory, "run.cjs");
    writeFileSync(
      launcher,
      `const { ChildProcess } = require("node:child_process");
const { run } = require("node:test");
// A stalled worker cannot run a signal listener. The runner's abort must stop it.
const kill = ChildProcess.prototype.kill;
ChildProcess.prototype.kill = function (signal = "SIGKILL") {
  return kill.call(this, signal);
};
const signal = AbortSignal.timeout(${discoveryTimeoutMs});
signal.addEventListener("abort", () => { process.exitCode = 1; }, { once: true });
run({
  files: ${JSON.stringify(bridges.map(({ entry }) => entry))},
  concurrency: 4,
  testNamePatterns: ${JSON.stringify(patterns)},
  signal,
}).resume();
`,
    );
    const outcome = spawnSync(
      process.execPath,
      [
        "--expose-internals",
        ...setup,
        // Discovery has no windows or test bodies, so workers can register in parallel.
        "--test-concurrency=4",
        launcher,
      ],
      // Node derives worker FORCE_COLOR from the stdout reporter destination.
      // Inherit the real runner's stdout so Node sees the same terminal.
      { env, stdio: ["ignore", "inherit", "ignore"] },
    );
    // The test runner cancels its own children before returning from a timeout.
    if (outcome.status !== 0) return new Map();

    const inventory = new Map();
    for (const { file, result } of bridges) {
      try {
        inventory.set(file, JSON.parse(readFileSync(result, "utf8")));
      } catch {
        inventory.set(file, undefined);
      }
    }
    return inventory;
  } catch {
    return new Map();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function discoverPlannedTests(files) {
  const inventory = discoverRegistrations(files);
  const names = new Map();
  for (const file of files) {
    const entry = inventory.get(file);
    if (!entry?.registrations)
      throw new Error(
        `Cannot inventory Electron suite ${file}: ${entry?.error ?? "discovery incomplete"}`,
      );
    for (const { name, sharded } of entry.registrations) {
      if (!sharded) continue;
      if (names.has(name))
        throw new Error(`Duplicate planned Electron test name in ${file}: ${name}`);
      names.set(name, file);
    }
  }
  return names;
}
