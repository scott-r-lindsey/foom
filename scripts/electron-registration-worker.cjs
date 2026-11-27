// Run in a disposable process. These Node 24 internals let the real node:test
// API build its tree (including suite callbacks and option validation) while
// preventing the execution phase. The caller retains files on discovery failure.
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { basename, sep } = require("node:path");
const Module = require("node:module");
const process = require("node:process");
const { createTestTree } = require("internal/test_runner/harness");
const { Test } = require("internal/test_runner/test");
const { parseCommandLine } = require("internal/test_runner/utils");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { fileURLToPath } = require("node:url");

const request = process.env.ELECTRON_REGISTRATION_REQUEST;
delete process.env.ELECTRON_REGISTRATION_REQUEST;
const { files, resultFile } = JSON.parse(readFileSync(request, "utf8"));
const cwd = process.cwd();
const environment = { ...process.env };
const execPath = process.execPath;
const workerArgs = process.execArgv.filter((arg) => arg !== "--expose-internals");
const fingerprints = new Map();
const output = new Map();
let loadedProjectEsm = false;

// Registration is allowed to load helpers, but must never launch anything.
const childProcess = require("node:child_process");
for (const method of [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]) {
  childProcess[method] = () => {
    throw new Error("Process launch during Electron suite registration");
  };
}
Module.syncBuiltinESMExports();
Test.prototype.start = async () => {};

Module.registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:")) return nextLoad(url, context);
    const file = fileURLToPath(url);
    if (!fingerprints.has(file)) {
      const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
      fingerprints.set(file, hash);
    }
    const loaded = nextLoad(url, context);
    if (loaded.format === "module" && localModule(file)) loadedProjectEsm = true;
    return loaded;
  },
});

function localModule(file) {
  return !file.split(sep).includes("node_modules");
}

async function inspect(file) {
  // Refresh project modules for each simulated worker. Sharing installed
  // packages keeps batch startup cheap (notably Playwright).
  for (const loaded of Object.keys(require.cache)) {
    if (loaded === file || localModule(loaded)) delete require.cache[loaded];
  }
  process.chdir(cwd);
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(environment, key)) delete process.env[key];
  }
  Object.assign(process.env, environment);
  process.argv = [execPath, file];
  process.execArgv = [...workerArgs];

  // A fresh root isolates hooks, ancestry, filters and registration failures.
  // Preserve the pre-existing process listeners when discarding the root.
  const events = ["beforeExit", "uncaughtException", "unhandledRejection"];
  const listeners = events.map((event) => new Set(process.rawListeners(event)));
  const options = parseCommandLine();
  const root = createTestTree(
    { entryFile: file },
    {
      ...options,
      cwd,
      testNamePatterns: options.testNamePatterns?.map((re) => new RegExp(re)) ?? null,
    },
  );
  try {
    Module._load(file, null, true);
    const tests = [];
    async function visit(parent) {
      for (const child of parent.subtests) {
        if (child.buildSuite) await child.buildSuite;
        if (child.error) throw child.error;
        tests.push(child);
        await visit(child);
      }
    }
    let complete = false;
    const result = visit(root).then(() => {
      complete = true;
    });
    await Promise.race([result, nextTurn()]);
    // A delayed suite callback can continue registering tests. Leave it and
    // the rest of this batch to real workers rather than mixing their roots.
    if (!complete) {
      output.set(file, { error: "Delayed Electron suite registration" });
      return false;
    }
    output.set(file, {
      registrations: tests.map((test) => ({
        name: test.name,
        fullName: test.getTestNameWithAncestors().trim(),
        matches: !test.filteredByName,
        sharded: Boolean(test.loc?.file && basename(test.loc.file) === "test-shard.js"),
      })),
    });
    return true;
  } catch (error) {
    output.set(file, { error: String(error) });
    return false;
  } finally {
    for (const [index, event] of events.entries()) {
      for (const listener of process.rawListeners(event)) {
        if (!listeners[index].has(listener)) process.removeListener(event, listener);
      }
    }
  }
}

(async () => {
  for (const file of files) {
    const complete = await inspect(file);
    // Node exposes eviction for CommonJS only. A fresh process gives the
    // next suite a clean ES module graph as well.
    if (!complete || loadedProjectEsm) break;
  }
  writeFileSync(
    resultFile,
    JSON.stringify({ entries: [...output], fingerprints: [...fingerprints] }),
  );
  process.exit(0);
})().catch(() => process.exit(1));
