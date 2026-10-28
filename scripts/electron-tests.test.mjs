import { gitSync } from "../tests/helpers/git.js";
import { evidencePath } from "../tests/helpers/evidence.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), "foom-wrapper-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "tests/helpers", "tests/electron", "src", "node_modules"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const name of [
    "electron-tests.mjs",
    "electron-summary.mjs",
    "validation-fingerprint.mjs",
    "remote-host-artifacts.mjs",
  ]) {
    cpSync(new URL(name, import.meta.url), join(root, "scripts", name));
  }
  for (const name of ["test-shard.js", "test-suites.js", "shard-plan.json"]) {
    cpSync(
      new URL(`../tests/electron/${name}`, import.meta.url),
      join(root, "tests/electron", name),
    );
  }
  for (const name of ["package.json", "pnpm-lock.yaml", ".npmrc", "tests/helpers/setup.js"]) {
    writeFileSync(join(root, name), name === "package.json" ? '{"version":"0.1.0"}' : "");
  }
  for (const name of ["git.js", "worktree-writes.js"]) {
    cpSync(new URL(`../tests/helpers/${name}`, import.meta.url), join(root, "tests/helpers", name));
  }
  writeFileSync(join(root, ".gitignore"), "build/\ntest-results/\nnode_modules/\n");
  writeFileSync(join(root, "src/input.ts"), "original");
  writeFileSync(join(root, "node_modules/types.d.ts"), "original declaration");
  writeFileSync(
    join(root, "scripts/build.mjs"),
    `
    import { mkdirSync, writeFileSync } from 'node:fs';
    mkdirSync('build', { recursive: true });
    writeFileSync('build/app.js', 'built');
  `,
  );
  writeFileSync(
    join(root, "scripts/build-remote-host.mjs"),
    `
    import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
    import { checkoutRevision, writeHostManifest } from './remote-host-artifacts.mjs';
    if (!existsSync('build/app.js')) throw Error('host built before app');
    appendFileSync('test-results/host-builds', 'build\\n');
    mkdirSync('build/remote-host', { recursive: true });
    writeFileSync('build/remote-host/foom-host', 'fixture host');
    if (process.env.TEST_HOST_FAILURE === 'build') process.exit(7);
    const manifest = await writeHostManifest('build/remote-host', {
      version: '0.1.0', platform: process.platform, arch: process.arch,
      source: checkoutRevision(process.cwd()),
    });
    if (process.env.TEST_HOST_FAILURE === 'revision') {
      manifest.source = 'a'.repeat(40);
      writeFileSync('build/remote-host/manifest.json', JSON.stringify(manifest));
    }
    if (process.env.TEST_HOST_FAILURE === 'gzip')
      writeFileSync('build/remote-host/foom-host.gz', 'corrupt');
    if (process.env.TEST_HOST_FAILURE === 'executable')
      writeFileSync('build/remote-host/foom-host', 'corrupt');
  `,
  );
  const suite = `const { test } = require('./test-shard.js');
    test('selected case', () => {
      require('node:assert/strict').ok(process.execArgv.includes('--test-concurrency=1'));
      console.log('SELECTED_BODY');
    });
    test('other case', () => { throw Error('UNSELECTED_BODY'); });`;
  for (const name of ["one.test.js", "packaged-smoke.js"]) {
    writeFileSync(join(root, "tests/electron", name), suite);
  }
  gitSync(["init", "--quiet"], { cwd: root });
  gitSync(["add", "."], { cwd: root });
  gitSync(
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "fixture"],
    { cwd: root },
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.FOOM_ELECTRON_SHARD;
  return {
    root,
    run: (args, extraEnv = {}) => {
      const result = spawnSync(process.execPath, ["scripts/electron-tests.mjs", ...args], {
        cwd: root,
        env: { ...env, ...extraEnv },
        encoding: "utf8",
      });
      return { ...result, output: result.stdout + result.stderr };
    },
  };
}

test("wrapper forwards both filter forms, reports executed tests and preserves sharding", (context) => {
  const { root, run } = fixture(context);
  for (const args of [
    ["--test-name-pattern", "^selected case$"],
    ["--test-name-pattern=^selected case$"],
  ]) {
    const result = run(args, { FOOM_ELECTRON_SHARD: "1/1" });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /SELECTED_BODY/);
    assert.doesNotMatch(result.output, /UNSELECTED_BODY/);
    assert.match(result.output, /1 selected tests passed/);
    assert.ok(
      readFileSync(join(root, "test-results/electron.xml"), "utf8").includes("selected case"),
    );
  }
  const shards = ["1/2", "2/2"].map((shard) =>
    run(["--reuse-build", "--test-name-pattern=^selected case$"], { FOOM_ELECTRON_SHARD: shard }),
  );
  assert.equal(shards.filter((result) => result.status === 0).length, 1);
  assert.match(shards.find((result) => result.status !== 0).output, /No selected tests passed/);
  writeFileSync(
    join(root, "tests/electron/two.test.js"),
    `const { test } = require('./test-shard.js');
      test('selected second', () => {
        require('node:assert/strict').ok(process.execArgv.includes('--test-concurrency=1'));
      });`,
  );
  const multiple = run(["--reuse-build", "--test-name-pattern=^selected"]);
  assert.equal(multiple.status, 0, multiple.output);
  assert.match(multiple.output, /2 selected tests passed/);
  const packaged = run(["--packaged", "--test-name-pattern=^selected case$"]);
  assert.equal(packaged.status, 0, packaged.output);
});

test("wrapper rejects invalid options, invalid regexes, zero matches, and propagates failures", (context) => {
  const { run } = fixture(context);
  for (const args of [
    ["--typo"],
    ["--test-name-pattern"],
    ["--test-name-pattern="],
    ["--test-name-pattern=["],
    ["--packaged", "--reuse-build"],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0, result.output);
  }
  const missing = run(["--test-name-pattern=does not exist"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.output, /No selected tests passed/);
  const failed = run(["--reuse-build", "--test-name-pattern=other case"]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /UNSELECTED_BODY/);
});

test("explicit build reuse rejects missing receipts and changed inputs, dependencies or output", (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  assert.notEqual(run(["--reuse-build", filter]).status, 0);
  assert.equal(run([filter]).status, 0);
  assert.equal(run(["--reuse-build", filter]).status, 0);
  for (const file of [
    "src/input.ts",
    "node_modules/types.d.ts",
    "tsconfig.json",
    "scripts/build.mjs",
    "build/app.js",
  ]) {
    const path = join(root, file);
    const before = file === "tsconfig.json" ? "" : readFileSync(path, "utf8");
    writeFileSync(path, before + "\n// change");
    assert.notEqual(run(["--reuse-build", filter]).status, 0, file);
    if (file === "tsconfig.json") rmSync(path);
    else writeFileSync(path, before);
    assert.equal(run(["--reuse-build", filter]).status, 0, file);
  }
});

test("suite selection validates inventory, executes only selected files and rejects zero tests", (context) => {
  const { root, run } = fixture(context);
  writeFileSync(join(root, "tests/electron/two.test.js"), `throw Error('UNSELECTED_FILE');`);
  const selected = run(["--suite=one.test.js", "--test-name-pattern=^selected case$"]);
  assert.equal(selected.status, 0, selected.output);
  assert.doesNotMatch(selected.output, /UNSELECTED_FILE/);
  for (const args of [
    ["--suite=missing.test.js"],
    ["--suite=../one.test.js"],
    ["--packaged", "--suite=one.test.js"],
    ["--suite=one.test.js", "--test-name-pattern=absent"],
  ]) {
    assert.notEqual(run(args).status, 0);
  }
  writeFileSync(join(root, "tests/electron/empty.test.js"), "");
  const empty = run(["--suite=empty.test.js"]);
  assert.notEqual(empty.status, 0, empty.output);
  assert.match(empty.output, /No selected tests passed/);
  const failed = run(["--suite=two.test.js"]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.output, /UNSELECTED_FILE/);
});

test("evidence helper creates nested destinations and rejects escaping paths", () => {
  const target = evidencePath("evidence-helper/nested/capture.png");
  assert.ok(target.endsWith(join("test-results", "evidence-helper", "nested", "capture.png")));
  writeFileSync(target, "fixture evidence");
  assert.equal(evidencePath(target), target);
  assert.equal(evidencePath("test-results/evidence-helper/nested/capture.png"), target);
  assert.throws(() => evidencePath("../escaped.png"), /must stay under/);
  assert.throws(() => evidencePath(join(tmpdir(), "escaped.png")), /must stay under/);
  rmSync(join(target, "../.."), { recursive: true, force: true });
});

for (const packaged of [false, true]) {
  for (const fails of [false, true]) {
    test(`worktree guard rejects leaked files after ${packaged ? "packaged" : "Electron"} ${fails ? "failure" : "success"}`, (t) => {
      const { root, run } = fixture(t);
      writeFileSync(join(root, "existing developer file.txt"), "keep me");
      const suite = packaged ? "packaged-smoke.js" : "one.test.js";
      writeFileSync(
        join(root, "tests/electron", suite),
        `
        const { test } = require('node:test');
        test('writes evidence', () => {
          require('node:fs').writeFileSync('leaked screenshot.png', 'evidence');
          ${fails ? "throw Error('fixture failure');" : ""}
        });
      `,
      );
      const result = run(packaged ? ["--packaged"] : []);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /Tests created untracked files outside/);
      assert.match(result.output, /leaked screenshot.png/);
      assert.doesNotMatch(result.output, /existing developer file.txt/);
      assert.equal(readFileSync(join(root, "existing developer file.txt"), "utf8"), "keep me");
    });
  }
}

test("worktree guard permits test-results and pre-existing untracked files", (t) => {
  const { root, run } = fixture(t);
  writeFileSync(join(root, "existing screenshot.png"), "keep me");
  writeFileSync(
    join(root, "tests/electron/one.test.js"),
    `
    const { test } = require('node:test');
    test('writes allowed evidence', () => {
      require('node:fs').mkdirSync('test-results/nested', { recursive: true });
      require('node:fs').writeFileSync('test-results/nested/capture.png', 'evidence');
    });
  `,
  );
  const result = run([]);
  assert.equal(result.status, 0, result.output);
});

test("worktree guard permits a temporary directory inside the checkout", (t) => {
  const { root, run } = fixture(t);
  const temporary = join(root, "temporary");
  mkdirSync(temporary);
  writeFileSync(
    join(root, "tests/electron/one.test.js"),
    `
    const { test } = require('node:test');
    test('writes temporary evidence', () => {
      require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'capture.png'), 'evidence');
    });
  `,
  );
  const result = run([], { TMPDIR: temporary, TMP: temporary, TEMP: temporary });
  assert.equal(result.status, 0, result.output);
});

test("runner builds and verifies one same-revision host before cases and reuses it", {
  skip: process.platform === "win32",
}, (context) => {
  const { root, run } = fixture(context);
  writeFileSync(
    join(root, "tests/electron/one.test.js"),
    `
    const { test } = require('./test-shard.js');
    const { readFileSync } = require('node:fs');
    for (const name of ['first remote', 'second remote']) test(name, () => {
      require('node:assert/strict').equal(
        readFileSync('test-results/host-builds', 'utf8'), 'build\\n');
      require('node:assert/strict').equal(
        readFileSync('build/remote-host/foom-host', 'utf8'), 'fixture host');
      require('node:assert/strict').equal(
        readFileSync('build/remote-hosts/' + process.platform + '-' + process.arch + '/manifest.json', 'utf8'),
        readFileSync('build/remote-host/manifest.json', 'utf8'));
    });
  `,
  );
  const fresh = run([]);
  assert.equal(fresh.status, 0, fresh.output);
  const reused = run(["--reuse-build"]);
  assert.equal(reused.status, 0, reused.output);
  assert.equal(readFileSync(join(root, "test-results/host-builds"), "utf8"), "build\n");
});

for (const failure of ["build", "revision", "gzip", "executable"]) {
  test(`runner rejects remote host ${failure} failure before running cases`, {
    skip: process.platform === "win32",
  }, (context) => {
    const { root, run } = fixture(context);
    const result = run(["--test-name-pattern=^selected case$"], { TEST_HOST_FAILURE: failure });
    assert.notEqual(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /SELECTED_BODY/);
    assert.throws(() => readFileSync(join(root, "test-results/electron-build.json")), {
      code: "ENOENT",
    });
  });
}
test("reused fixture rejects a new checkout revision even with unchanged build inputs", {
  skip: process.platform === "win32",
}, (context) => {
  const { root, run } = fixture(context);
  const filter = "--test-name-pattern=^selected case$";
  assert.equal(run([filter]).status, 0);
  gitSync(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "next revision",
    ],
    { cwd: root },
  );
  const stale = run(["--reuse-build", filter]);
  assert.notEqual(stale.status, 0, stale.output);
  assert.match(stale.output, /Host source revision mismatch/);
  assert.doesNotMatch(stale.output, /SELECTED_BODY/);
});
