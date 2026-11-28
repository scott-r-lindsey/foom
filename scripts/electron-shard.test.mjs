import { discoverPlannedTests, discoverRegistrations } from "./electron-registration.mjs";
import { selectAffected } from "./electron-affected.mjs";
import { selectSuiteFiles } from "./electron-selection.mjs";
import { suiteFiles } from "../tests/electron/test-suites.js";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { gitSync } from "../tests/helpers/git.js";

function isolateNodeOptions(context) {
  const inherited = process.env.NODE_OPTIONS;
  delete process.env.NODE_OPTIONS;
  context.after(() => {
    if (inherited !== undefined) process.env.NODE_OPTIONS = inherited;
  });
}

test("Electron shards register every test exactly once, preserve filtering and reject invalid shards", (context) => {
  isolateNodeOptions(context);
  const directory = mkdtempSync(path.join(tmpdir(), "foom-shard-#-"));
  try {
    for (const name of ["test-shard.js", "shard-assignment.js", "shard-plan.json"])
      cpSync(new URL(`../tests/electron/${name}`, import.meta.url), path.join(directory, name));
    // Collect actual registrations in every discovered suite, including generated
    // cases, without invoking a test body or launching Electron/agent fixtures.
    const inventory = suiteFiles();
    const worktreeStatus = () =>
      gitSync(["status", "--porcelain", "--ignored", "--untracked-files=all"], {
        cwd: new URL("../", import.meta.url),
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    const beforeDiscovery = worktreeStatus();
    const registrations = discoverPlannedTests(inventory);
    assert.ok(
      worktreeStatus() === beforeDiscovery,
      "Electron suite registration changed worktree status. Move file writes into test bodies or hooks.",
    );
    const baseline = discoverRegistrations(inventory);
    for (const [name, file] of [
      ["agent discovery uses the fixture login shell and controlled PATH", "harness.test.js"],
      [
        "shared board startup restores a native-hidden CDP-visible board and delivers frames",
        "application.test.js",
      ],
      ["owned child review loop: clean", "review-loop.test.js"],
    ]) {
      assert.deepEqual(
        selectSuiteFiles(inventory, { patterns: [`^${name}$`] }).map((file) => path.basename(file)),
        inventory
          .filter((suite) => path.basename(suite) === file || baseline.get(suite)?.fileHooks)
          .map((suite) => path.basename(suite)),
      );
    }
    const suiteNames = [...registrations.keys()];
    assert.ok(suiteNames.length > 0);
    const plan = JSON.parse(
      readFileSync(new URL("../tests/electron/shard-plan.json", import.meta.url), "utf8"),
    );
    const discoveredFiles = inventory.map((file) => path.basename(file));
    for (const count of new Set([1, ...Object.values(plan.shardCounts)])) {
      const registered = [];
      for (let index = 1; index <= count; index++) {
        const shard = `${index}/${count}`;
        const discovered = discoverRegistrations(inventory, { shard });
        for (const file of inventory) {
          const entry = discovered.get(file);
          assert.ok(
            entry?.registrations,
            `Cannot inventory ${path.basename(file)} on shard ${shard}`,
          );
          for (const { name, sharded } of entry.registrations) {
            if (sharded) registered.push(name);
          }
        }
      }
      assert.deepEqual(
        registered.sort(),
        [...suiteNames].sort(),
        `Registrations at ${count} shards`,
      );
    }
    const previewSuites = selectAffected(["src/renderer/preview/markdown.ts"]).suites;
    const terminalSuites = selectAffected(["src/renderer/terminal/shell-controller.ts"]).suites;
    for (const [original, replacements] of Object.entries(plan.suiteSplits)) {
      assert.ok(!discoveredFiles.includes(original), `Retired suite: ${original}`);
      assert.equal(new Set(replacements).size, replacements.length);
      for (const replacement of replacements) {
        assert.ok(discoveredFiles.includes(replacement), `Missing suite: ${replacement}`);
        if (original === "previews.test.js")
          assert.ok(
            previewSuites.includes(replacement),
            `Missing preview coverage: ${replacement}`,
          );
        assert.ok(
          terminalSuites.includes(replacement),
          `Missing terminal coverage: ${replacement}`,
        );
      }
    }
    const plannedNames = Object.values(plan.shards).flatMap((shards) =>
      shards.flatMap(Object.keys),
    );
    for (const [count, shards] of Object.entries(plan.shards)) {
      assert.equal(shards.length, Number(count));
      const names = shards.flatMap(Object.keys);
      assert.equal(new Set(names).size, names.length, "duplicate planned test");
    }
    for (const count of Object.values(plan.shardCounts)) assert.ok(plan.shards[count]);
    assert.ok(
      plannedNames.every((name) => suiteNames.includes(name)),
      "remove stale plan names",
    );
    for (const shard of Object.values(plan.shards).flat()) {
      for (const durations of Object.values(shard)) {
        assert.equal(durations.length, plan.platforms.length);
        assert.ok(durations.every((seconds) => Number.isFinite(seconds) && seconds >= 0));
      }
    }
    const hashCases = Array.from({ length: 41 }, (_, index) => `case ${index}`);
    const names = [...suiteNames, ...hashCases];
    const suites = inventory.map((file) =>
      suiteNames.filter((name) => registrations.get(name) === file),
    );
    const fixtures = [...suites, hashCases].map((cases, index) => {
      const file = path.join(directory, `${index}.test.cjs`);
      writeFileSync(
        file,
        'const { test } = require("./test-shard.js");\n' +
          cases.map((name) => `test(${JSON.stringify(name)}, () => {});`).join("\n"),
      );
      return file;
    });
    // TAP escapes Windows separators and # in empty-file placeholder names.
    const filePlaceholders = new Set(
      fixtures.map((file) => file.replaceAll("\\", "\\\\").replaceAll("#", "\\#")),
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // The fixture needs its own runner and text reporter.
    const run = (shard, args = [], files = fixtures) =>
      spawnSync(
        process.execPath,
        ["--test", "--test-concurrency=1", "--test-reporter=tap", ...args, ...files],
        {
          encoding: "utf8",
          env: { ...env, FOOM_ELECTRON_SHARD: shard },
        },
      );
    for (const count of new Set([1, 2, 3, 4, 5, 6, 16, ...Object.values(plan.shardCounts)])) {
      const registered = [];
      const measured = plan.shards[count];
      const shardNames = measured ? suiteNames : names;
      const input = measured ? fixtures.slice(0, -1) : fixtures;
      for (let index = 1; index <= count; index++) {
        const shard = `${index}/${count}`;
        const expected = shardNames.filter((name) => {
          const planned = measured?.findIndex((tests) => Object.hasOwn(tests, name)) ?? -1;
          const bucket =
            planned >= 0
              ? planned
              : createHash("sha256").update(name).digest().readUInt32BE(0) % count;
          return bucket === index - 1;
        });
        const result = run(shard, [], input);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.doesNotMatch(result.stdout, /# SKIP/);
        const selected = Array.from(
          result.stdout.matchAll(/^ok \d+ - (.+)$/gm),
          (match) => match[1],
        ).filter((name) => !filePlaceholders.has(name)); // Node reports empty files as passing placeholders.
        assert.deepEqual(selected.sort(), expected.sort(), shard);
        registered.push(...selected);
      }
      assert.deepEqual(registered.sort(), [...shardNames].sort());
    }
    const unsharded = spawnSync(
      process.execPath,
      ["--test", "--test-concurrency=1", "--test-reporter=tap", ...fixtures],
      {
        encoding: "utf8",
        env: Object.fromEntries(
          Object.entries(env).filter(([key]) => key !== "FOOM_ELECTRON_SHARD"),
        ),
      },
    );
    assert.equal(unsharded.status, 0, unsharded.stdout + unsharded.stderr);
    assert.deepEqual(
      Array.from(unsharded.stdout.matchAll(/^ok \d+ - (.+)$/gm), (match) => match[1]).sort(),
      [...names].sort(),
    );
    const filtered = run("1/1", ["--test-name-pattern=^case 3$"]);
    assert.equal(filtered.status, 0, filtered.stdout + filtered.stderr);
    assert.match(filtered.stdout, /^ok \d+ - case 3$/m);
    for (const shard of [
      "",
      "0/2",
      "3/2",
      "1/0",
      "1/17",
      "all",
      "1.5/4",
      "NaN/4",
      "9007199254740993/4",
      "1/9007199254740993",
    ]) {
      const result = run(shard);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /FOOM_ELECTRON_SHARD/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uncertain Electron registration preserves worker-only and ancestor-qualified tests", async (context) => {
  isolateNodeOptions(context);
  const directory = mkdtempSync(path.join(tmpdir(), "foom-shard-worker-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const suiteDirectory = path.join(directory, "tests/electron");
  const helpers = path.join(directory, "tests/helpers");
  const scripts = path.join(directory, "scripts");
  for (const folder of [suiteDirectory, helpers, scripts]) mkdirSync(folder, { recursive: true });
  for (const name of ["setup.js", "environment.js", "git.js"])
    cpSync(new URL(`../tests/helpers/${name}`, import.meta.url), path.join(helpers, name));
  for (const name of ["shard-assignment.js", "test-shard.js"])
    cpSync(new URL(`../tests/electron/${name}`, import.meta.url), path.join(suiteDirectory, name));
  const selector = path.join(scripts, "electron-selection.mjs");
  cpSync(new URL("./electron-selection.mjs", import.meta.url), selector);
  for (const name of ["electron-registration.mjs", "electron-registration-worker.cjs"]) {
    cpSync(new URL(name, import.meta.url), path.join(scripts, name));
  }
  writeFileSync(
    path.join(suiteDirectory, "shard-plan.json"),
    JSON.stringify({
      shards: {
        2: [{ first: [] }, { second: [] }],
        4: [{ first: [] }, { second: [] }, {}, {}],
      },
    }),
  );
  const { selectSuiteFiles: select } = await import(pathToFileURL(selector).href);
  const { discoverRegistrations: discover, discoverPlannedTests: planTests } = await import(
    pathToFileURL(path.join(scripts, "electron-registration.mjs")).href
  );
  const first = path.join(suiteDirectory, "first.test.cjs");
  const second = path.join(suiteDirectory, "second.test.cjs");
  const files = [first, second];
  const binding = 'const { test } = require("./test-shard.js");\n';
  writeFileSync(first, binding + 'test("first", () => {});');
  writeFileSync(second, binding + 'test("second", () => {});');

  await context.test("inherited Node options keep the full suite list", (context) => {
    process.env.NODE_OPTIONS = "--max-old-space-size=4096";
    context.after(() => delete process.env.NODE_OPTIONS);
    assert.deepEqual(select(files, { patterns: ["^first$"] }), files);
  });

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  function runWorker(shard, patterns, inventory = files, expectedStatus = 0) {
    const selected = shard === undefined ? select(inventory, { patterns }) : inventory;
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        `./${path.relative(process.cwd(), path.join(helpers, "setup.js"))}`,
        "--test",
        "--test-concurrency=1",
        "--test-reporter=tap",
        ...patterns.map((pattern) => `--test-name-pattern=${pattern}`),
        ...selected,
      ],
      { encoding: "utf8", env: { ...env, FOOM_ELECTRON_SHARD: shard } },
    );
    const output = result.stdout + result.stderr;
    assert.equal(result.status, expectedStatus, output);
    return { selected, output };
  }

  await context.test("an empty inventory never runs Node's default discovery", () => {
    const cwd = path.join(directory, "empty-inventory");
    mkdirSync(cwd);
    writeFileSync(
      path.join(cwd, "unrelated.test.cjs"),
      `require("node:test").test("unrelated", () => {
        require("node:fs").writeFileSync("body-marker", "test body ran");
      });`,
    );
    const registration = pathToFileURL(path.join(scripts, "electron-registration.mjs")).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { discoverPlannedTests } from ${JSON.stringify(registration)};
        if (discoverPlannedTests([]).size !== 0) throw Error("Nonempty inventory");`,
      ],
      { cwd, env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(cwd), ["unrelated.test.cjs"]);
  });

  await context.test(
    "focused registration sees the real preload and name pattern arguments",
    () => {
      writeFileSync(first, binding + 'test("target passes", () => {});');
      writeFileSync(
        second,
        binding +
          `const name = process.execArgv.includes("--require") &&
          process.execArgv.includes("--test-name-pattern=^target") ? "target fails" : "other";
        test(name, () => { throw Error("matching failure"); });`,
      );
      const run = runWorker(undefined, ["^target"], files, 1);
      assert.deepEqual(run.selected, files);
      assert.match(run.output, /matching failure/);
    },
  );

  await context.test("focused registration sees the real worker color environment", (context) => {
    const setup = path.join(helpers, "setup.js");
    const originalSetup = readFileSync(setup, "utf8");
    context.after(() => writeFileSync(setup, originalSetup));
    // Simulate a color-capable terminal on the captured stdout pipe. Ignored
    // stdout has no pipe, so discovery must inherit the runner's descriptor.
    writeFileSync(
      setup,
      `${originalSetup}
      if (!process.env.NODE_TEST_CONTEXT && process.stdout instanceof require("node:net").Socket) {
        process.stdout.isTTY = true;
        process.stdout.getColorDepth = () => 8;
      }`,
    );
    writeFileSync(first, binding + 'test("target passes", () => {});');
    writeFileSync(
      second,
      binding +
        `const name = process.env.FORCE_COLOR === "1" ? "target fails in color" : "other";
        test(name, () => { throw Error("matching color failure"); });`,
    );
    const colorEnv = { ...env };
    delete colorEnv.FORCE_COLOR;
    delete colorEnv.NO_COLOR;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { spawnSync } from "node:child_process";
        import { selectSuiteFiles } from ${JSON.stringify(pathToFileURL(selector).href)};
        const files = selectSuiteFiles(${JSON.stringify(files)}, { patterns: ["^target"] });
        const result = spawnSync(process.execPath, [
          "--require", ${JSON.stringify(setup)}, "--test", "--test-concurrency=1",
          "--test-reporter=spec", "--test-reporter-destination=stdout",
          "--test-name-pattern=^target", ...files,
        ], { stdio: "inherit" });
        process.exitCode = result.status ?? 2;`,
      ],
      { env: colorEnv, encoding: "utf8" },
    );
    assert.match(result.stdout + result.stderr, /matching color failure/);
    assert.equal(result.status, 1);
  });

  await context.test("a stalled discovery worker is stopped before the real tests run", () => {
    const marker = path.join(directory, "blocked-registration-returned");
    writeFileSync(first, binding + 'test("first", () => {});');
    writeFileSync(
      second,
      binding +
        `const { before } = require("node:test");
        let ready = false;
        before(() => { ready = true; });
        test("second", () => {});
        queueMicrotask(() => {
          if (ready) return;
          process.once("SIGTERM", () => {});
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
          require("node:fs").writeFileSync(${JSON.stringify(marker)}, "registration was not stopped");
        });`,
    );
    const run = runWorker(undefined, ["^first$|^second$"]);
    assert.deepEqual(run.selected, files);
    assert.match(run.output, /ok \d+ - second/);
    assert.ok(!readdirSync(directory).includes(path.basename(marker)));
  });

  await context.test("selection reads updated registration data on each call", () => {
    const cases = path.join(suiteDirectory, "cases.json");
    writeFileSync(first, binding + 'test("target passes", () => {});');
    writeFileSync(
      second,
      binding +
        `const { readFileSync } = require("node:fs");
        const { join } = require("node:path");
        for (const name of JSON.parse(readFileSync(join(__dirname, "cases.json"), "utf8"))) {
          test(name, () => { throw Error("generated test failed"); });
        }`,
    );
    writeFileSync(cases, JSON.stringify(["other case"]));
    const patterns = ["^target"];
    assert.deepEqual(runWorker(undefined, patterns).selected, [first]);
    writeFileSync(cases, JSON.stringify(["target fails"]));
    const focused = runWorker(undefined, patterns, files, 1);
    assert.deepEqual(focused.selected, files);
    assert.match(focused.output, /generated test failed/);
  });

  await context.test("deferred top-level cases remain visible to the runner and planner", () => {
    let lateName = "late target";
    while (createHash("sha256").update(lateName).digest().readUInt32BE(0) % 4 !== 1)
      lateName += "!";
    writeFileSync(first, binding + 'test("second", () => {});');
    writeFileSync(
      second,
      binding +
        `test("first", () => {});
      setImmediate(() => test(${JSON.stringify(lateName)}, () => { throw Error("late body failed"); }));`,
    );
    for (const [shard, patterns] of [
      ["2/4", []],
      [undefined, ["^second$|^late target"]],
    ]) {
      const real = runWorker(shard, patterns, files, 1);
      assert.deepEqual(real.selected, files);
      assert.match(real.output, /late body failed/);
    }
    assert.equal(planTests(files).get(lateName), second);
  });

  await context.test("pending timers and lifecycle callbacks make registration uncertain", () => {
    writeFileSync(first, binding + 'test("first", () => {});');
    for (const source of [
      'setTimeout(() => test("delayed", () => {}), 60_000).unref();',
      'process.once("beforeExit", () => test("delayed", () => {}));',
    ]) {
      writeFileSync(second, binding + 'test("second", () => {});' + source);
      assert.match(discover(files).get(second).error, /registration did not settle/);
      assert.throws(() => planTests(files), /registration did not settle/);
      assert.deepEqual(select(files, { patterns: ["^first$"] }), files);
    }
  });

  await context.test("file-scope hooks retain suites in focused runs", () => {
    writeFileSync(first, binding + 'test("first", () => {});');
    for (const name of ["before", "after", "beforeEach", "afterEach"]) {
      writeFileSync(
        second,
        binding +
          `const { ${name} } = require("node:test");
          ${name}(() => { throw Error("file hook ran"); });
          test("second", () => {});`,
      );
      assert.equal(discover(files).get(second).fileHooks, true, name);
      assert.deepEqual(select(files, { patterns: ["^first$"] }), files, name);
      if (name === "after") {
        const focused = runWorker(undefined, ["^first$"], files, 1);
        assert.match(focused.output, /file hook ran/);
      }
    }
  });

  await context.test("a nonzero suite exit code survives discovery and name filtering", () => {
    writeFileSync(first, binding + 'test("first", () => {});');
    for (const source of [
      "process.exitCode = 7;",
      "queueMicrotask(() => { process.exitCode = 7; });",
    ]) {
      writeFileSync(second, binding + 'test("second", () => {});' + source);
      assert.match(discover(files).get(second).error, /exit code 7/);
      const focused = runWorker(undefined, ["^first$"], files, 1);
      assert.deepEqual(focused.selected, files);
      assert.match(focused.output, /exitCode: 7/);
    }
  });

  await context.test("caught registration guard errors keep a suite uncertain", () => {
    writeFileSync(first, binding + 'test("first", () => {});');
    writeFileSync(
      second,
      binding +
        `const childProcess = require("node:child_process");
        for (let attempt = 0; attempt < 2; attempt++) {
          try { childProcess.spawnSync(process.execPath, ["--version"]); } catch {}
        }
        // Invalid ports fail before opening a socket in the real runner.
        try { require("node:net").connect(-1); } catch {}
        test("second", () => {});`,
    );
    assert.match(discover(files).get(second).error, /registration guard 3 time/);
    assert.deepEqual(runWorker(undefined, ["^first$"]).selected, files);
  });

  await context.test("the process guard covers Git APIs captured by setup", () => {
    writeFileSync(first, binding + 'test("first", () => {});');
    writeFileSync(
      second,
      binding +
        `const { gitSync } = require("../helpers/git.js");
        try { gitSync(["--version"]); } catch {}
        test("second", () => {});`,
    );
    assert.match(discover(files).get(second).error, /registration guard 1 time/);
  });

  await context.test("discovery runs synchronous exit cleanup", () => {
    const storage = path.join(directory, "storage");
    mkdirSync(storage);
    writeFileSync(
      second,
      binding +
        `const { mkdtempSync, rmSync } = require("node:fs");
        const directory = mkdtempSync(${JSON.stringify(path.join(storage, "fixture-"))});
        process.once("exit", () => rmSync(directory, { recursive: true }));
        test("second", () => {});`,
    );
    assert.match(discover([second]).get(second).error, /registration did not settle/);
    assert.deepEqual(readdirSync(storage), []);
  });

  await context.test("each suite sees its own process globals", () => {
    writeFileSync(
      first,
      binding +
        `
      globalThis.generatedFixtureNames = ["unrelated"];
      test("target A", () => {});
    `,
    );
    writeFileSync(
      second,
      binding +
        `
      globalThis.generatedFixtureNames ??= ["target B"];
      for (const name of globalThis.generatedFixtureNames)
        test(name, () => { throw Error("isolated body failed"); });
    `,
    );
    const focused = runWorker(undefined, ["^target"], files, 1);
    assert.deepEqual(focused.selected, files);
    assert.match(focused.output, /isolated body failed/);
    assert.equal(planTests(files).get("target B"), second);
  });

  await context.test("generated worker names are assigned exactly once", () => {
    writeFileSync(first, binding + 'test("first", () => {});');
    writeFileSync(second, binding + 'test("second", () => {});');
    const workerOnlyName = "worker-only case";
    const bucket = createHash("sha256").update(workerOnlyName).digest().readUInt32BE(0) % 2;
    const otherFile = files[1 - bucket];
    const otherName = bucket === 0 ? "second" : "first";
    writeFileSync(
      path.join(suiteDirectory, "cases.cjs"),
      `const { basename } = require("node:path");
      module.exports = process.env.NODE_TEST_CONTEXT === "child-v8"
        && process.env.NODE_TEST_WORKER_ID === "1"
        && process.execArgv.includes("--test-concurrency=1")
        && basename(process.argv[1] ?? "") === ${JSON.stringify(path.basename(otherFile))}
        ? [${JSON.stringify(workerOnlyName)}] : [];`,
    );
    writeFileSync(
      otherFile,
      binding +
        `test(${JSON.stringify(otherName)}, () => {});
        for (const name of require("./cases.cjs")) test(name, () => {});`,
    );
    const passed = [];
    const selections = [];
    for (const shard of ["1/2", "2/2"]) {
      const { selected, output } = runWorker(shard, []);
      selections.push(selected);
      passed.push(
        ...Array.from(output.matchAll(/^ok \d+ - (first|second|worker-only case)$/gm), (m) => m[1]),
      );
    }
    assert.deepEqual(passed.sort(), ["first", "second", workerOnlyName]);
    assert.deepEqual(selections, [files, files]);
    assert.equal(planTests(files).get(workerOnlyName), otherFile);
    assert.deepEqual(runWorker(undefined, [`^${workerOnlyName}$`]).selected, [otherFile]);
    // Changing just a dependency invalidates the inventory for the same files.
    writeFileSync(path.join(suiteDirectory, "cases.cjs"), 'module.exports = ["updated case"];');
    assert.equal(planTests(files).get("updated case"), otherFile);
    assert.ok(!planTests(files).has(workerOnlyName));
  });

  await context.test("focused filters match a child through an imported describe", () => {
    writeFileSync(path.join(suiteDirectory, "group.cjs"), 'module.exports = require("node:test");');
    writeFileSync(
      first,
      binding +
        'const { describe } = require("./group.cjs");\n' +
        'describe("group", () => test("child", () => {}));',
    );
    // The flat match would let bare-name discovery narrow away the nested match.
    writeFileSync(second, binding + 'test("group child", () => {});');
    assert.equal(planTests(files).get("child"), first);
    assert.deepEqual(
      discover([first])
        .get(first)
        .registrations.map(({ fullName }) => fullName),
      ["group", "group child"],
    );
    const focused = runWorker(undefined, ["^group child$"]);
    assert.match(focused.output, /^\s+ok \d+ - child$/m);
    assert.match(focused.output, /^ok \d+ - group child$/m);
    assert.deepEqual(focused.selected, files);
    const third = path.join(suiteDirectory, "third.test.cjs");
    writeFileSync(third, binding + 'test("unrelated", () => {});');
    for (const [pattern, expected] of [
      ["^group child$", files],
      ["^group$", [first]],
    ]) {
      const matching = runWorker(undefined, [pattern], [...files, third]);
      assert.deepEqual(matching.selected, expected);
      assert.match(matching.output, /^\s+ok \d+ - child$/m);
    }
  });

  await context.test("ES module helpers see each suite's worker argv", () => {
    writeFileSync(
      path.join(suiteDirectory, "case.mjs"),
      'import { basename } from "node:path"; export const name = basename(process.argv[1]);',
    );
    for (const file of files) {
      writeFileSync(file, binding + 'test(require("./case.mjs").name, () => {});');
    }
    assert.deepEqual([...planTests(files).keys()], ["first.test.cjs", "second.test.cjs"]);
    assert.deepEqual(runWorker(undefined, ["^second[.]test[.]cjs$"]).selected, [second]);
  });

  await context.test(
    "Node chooses the suite callback and validates hooks without running them",
    () => {
      writeFileSync(
        first,
        binding +
          `
      const { describe, before, after, beforeEach, afterEach } = require("node:test");
      describe("group", () => {
        for (const hook of [before, after, beforeEach, afterEach]) {
          hook(() => { throw Error("hook executed during discovery"); });
        }
        test("real child", () => { throw Error("test body executed during discovery"); });
      }, () => { throw Error("wrong callback executed"); });
    `,
      );
      writeFileSync(second, binding + 'test("other", () => {});');
      assert.deepEqual(
        discover([first])
          .get(first)
          .registrations.map(({ fullName }) => fullName),
        ["group", "group real child"],
      );
      assert.equal(planTests(files).get("real child"), first);
      assert.deepEqual(select(files, { patterns: ["^group real child$"] }), [first]);
    },
  );

  for (const [regression, source, error] of [
    [
      "invalid options fail during registration",
      'test("second", { timeout: -1 }, () => {});',
      /options\.timeout/,
    ],
    [
      "invalid destructuring fails during module initialization",
      'const { attribute } = undefined; test("other", () => attribute);',
      /Cannot destructure/,
    ],
    [
      "a failing synchronous describe stays uncertain",
      'const { describe } = require("node:test"); describe("group", () => { throw Error("building group failed"); });',
      /building group failed/,
    ],
  ]) {
    await context.test(regression, () => {
      writeFileSync(first, binding + 'test("first", () => {});');
      writeFileSync(second, binding + source);
      assert.match(discover(files).get(second).error, error);
      assert.throws(() => planTests(files), error);
      if (regression !== "a failing synchronous describe stays uncertain") {
        const focused = runWorker(undefined, ["^first$"], files, 1);
        assert.deepEqual(focused.selected, files);
        assert.match(focused.output, error);
      }
    });
  }

  await context.test("a syntax error in a nonmatching suite reaches the worker", () => {
    writeFileSync(first, binding + 'test("keep me", () => {});');
    writeFileSync(second, binding + 'test("other", () => { break; });');
    const focused = runWorker(undefined, ["^keep me$"], files, 1);
    assert.deepEqual(focused.selected, files);
    assert.match(focused.output, /SyntaxError: Illegal break statement/);
  });
});
