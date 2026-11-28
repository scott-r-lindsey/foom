// Each bridge runs in its own Node 24 test worker. Use Node's registration
// logic, but suppress the execution phase so bodies and hooks never run.
const { createHook } = require("node:async_hooks");
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { basename } = require("node:path");
const Module = require("node:module");
const process = require("node:process");
const { setImmediate } = require("node:timers");
const { fileURLToPath } = require("node:url");
const { createTestTree } = require("internal/test_runner/harness");
const { Test } = require("internal/test_runner/test");
const { parseCommandLine } = require("internal/test_runner/utils");

module.exports = (file, resultFile) => {
  process.argv[1] = file;
  // Match the visible controls in the serial runner, independently of how
  // many discovery processes the parent can start at once.
  process.env.NODE_TEST_WORKER_ID = "1";
  process.execArgv = process.execArgv
    .filter((arg) => arg !== "--expose-internals")
    .map((arg) => (arg.startsWith("--test-concurrency=") ? "--test-concurrency=1" : arg));

  let guardHits = 0;
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
      guardHits++;
      throw new Error("Process launch during Electron suite registration");
    };
  }
  Module.syncBuiltinESMExports();
  Test.prototype.start = () => {};
  // Node can run a file-level before hook as soon as it is registered.
  Test.prototype.run = async () => {};

  const fingerprints = new Map();
  Module.registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith("file:")) {
        const path = fileURLToPath(url);
        if (!fingerprints.has(path)) {
          fingerprints.set(path, createHash("sha256").update(readFileSync(path)).digest("hex"));
        }
      }
      return nextLoad(url, context);
    },
  });

  const root = createTestTree({ entryFile: file }, { ...parseCommandLine(), cwd: process.cwd() });
  const originalExitListeners = new Set(process.rawListeners("exit"));
  const originalBeforeExitListeners = new Set(process.rawListeners("beforeExit"));
  const pending = new Map();
  let track = true;
  const hook = createHook({
    init(id, type, _trigger, resource) {
      if (track && type !== "Test" && type !== "TestHook") pending.set(id, resource);
    },
    destroy(id) {
      pending.delete(id);
    },
    promiseResolve(id) {
      pending.delete(id);
    },
  });
  const exit = process.exit.bind(process);
  function report(entry) {
    hook.disable();
    writeFileSync(resultFile, JSON.stringify({ entry, fingerprints: [...fingerprints] }));
    for (const listener of process.rawListeners("exit")) {
      if (!originalExitListeners.has(listener)) process.removeListener("exit", listener);
    }
    exit();
  }
  process.on("uncaughtExceptionMonitor", (error) => report({ error: String(error) }));
  process.on("unhandledRejection", (error) => report({ error: String(error) }));

  function checkLoad() {
    if (process.exitCode) {
      throw new Error(`Electron suite set exit code ${process.exitCode} during registration`);
    }
    if (guardHits > 0) {
      throw new Error(`Electron suite hit the registration guard ${guardHits} time(s)`);
    }
  }

  function collect(parent, tests, nativePromises) {
    if (parent.error) throw parent.error;
    // Node leaves these promises pending because test execution is suppressed.
    nativePromises.add(parent.subtestsPromise?.promise);
    for (const test of parent.subtests) {
      if (test.buildSuite && !test.buildPhaseFinished) {
        throw new Error("Deferred Electron suite registration did not settle");
      }
      tests.push({
        name: test.name,
        fullName: test.getTestNameWithAncestors().trim(),
        matches: !test.filteredByName,
        sharded: Boolean(test.loc?.file && basename(test.loc.file) === "test-shard.js"),
      });
      collect(test, tests, nativePromises);
    }
  }

  function finish() {
    try {
      checkLoad();
      const registrations = [];
      const nativePromises = new Set();
      collect(root, registrations, nativePromises);
      if (
        [...pending.values()].some((resource) => !nativePromises.has(resource)) ||
        process
          .rawListeners("beforeExit")
          .some((listener) => !originalBeforeExitListeners.has(listener)) ||
        process.rawListeners("exit").some((listener) => !originalExitListeners.has(listener))
      ) {
        throw new Error("Deferred Electron suite registration did not settle");
      }
      const fileHooks = ["before", "after", "beforeEach", "afterEach"].some(
        (name) => root.hooks[name].length > 0,
      );
      report({ registrations, fileHooks });
    } catch (error) {
      report({ error: String(error) });
    }
  }

  // Let microtasks and already queued immediates run. If they leave work
  // pending, retain the file rather than guessing which tests it registers.
  function afterTurn(callback) {
    track = false;
    setImmediate(callback);
    track = true;
  }

  try {
    hook.enable();
    Module._load(file, null, true);
    checkLoad();
    afterTurn(() => afterTurn(finish));
  } catch (error) {
    report({ error: String(error) });
  }
};
