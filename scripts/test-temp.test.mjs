import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import gitHelper from "../tests/helpers/git.js";

const wrapper = fileURLToPath(new URL("./test-temp.mjs", import.meta.url));
function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), "foom-temp-check-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const temporary = join(root, "temporary");
  const script = join(root, "fixture.cjs");
  mkdirSync(temporary);
  const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
  delete env.NODE_TEST_CONTEXT;
  return {
    root,
    script,
    temporary,
    env,
  };
}
const allocate = `
const { mkdtempSync, writeFileSync, writeSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
for (const prefix of ['foom-v2-hooks-', 'foom-v2-', 'foom-hooks-', 'foom-health-', 'foom-shell-', 'foom-verdict-', 'foom-entry-', 'foom-agent-isolation-', 'foom-environment-', 'foom-probe-verification-', 'scoped_dir', 'electron-download-', 'playwright-artifacts-']) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(directory, 'fixture'), 'owned');
}
for (const root of [process.env.FOOM_TEST_DISK_ROOT, process.env.FOOM_TEST_SHARED_MEMORY_ROOT].filter(Boolean)) {
  const directory = mkdtempSync(join(root, 'foom-outside-temp-'));
  writeFileSync(join(directory, 'fixture'), 'owned');
}
writeSync(1, 'FOOM_TEST_ROOTS ' + JSON.stringify([process.env.TMPDIR, process.env.FOOM_TEST_DISK_ROOT, process.env.FOOM_TEST_SHARED_MEMORY_ROOT]) + String.fromCharCode(10));
`;
function assertRemoved(output) {
  const roots = JSON.parse(output.match(/FOOM_TEST_ROOTS (\[[^\n]*\])/)[1]);
  assert.ok(roots.filter(Boolean).length >= 2);
  for (const root of roots.filter(Boolean)) assert.equal(existsSync(root), false, root);
}

for (const ending of ["", "throw Error('assertion failure');", "process.exit(1);"]) {
  test(`run root removes every fixture prefix after ${ending || "success"}`, (context) => {
    const { script, temporary, env } = fixture(context);
    writeFileSync(script, allocate + ending);
    const child = spawnSync(process.execPath, [wrapper, script], {
      env,
      encoding: "utf8",
    });
    assert.ifError(child.error);
    assert.equal(child.status, ending ? 1 : 0, child.stderr);
    assert.match(child.stdout, /Test temp leak check/);
    assertRemoved(child.stdout);
    assert.deepEqual(readdirSync(temporary), []);
  });
}

test("a worker killed without exit handlers cannot leak any of its roots", (context) => {
  const { script, temporary, env } = fixture(context);
  writeFileSync(script, allocate + "process.kill(process.pid, 'SIGKILL');");
  const child = spawnSync(process.execPath, [wrapper, script], { env, encoding: "utf8" });
  assert.ifError(child.error);
  assert.notEqual(child.status, 0, child.stderr);
  assertRemoved(child.stdout);
  assert.deepEqual(readdirSync(temporary), []);
});

test("worker killed by test timeout cannot leak its fixtures", (context) => {
  const { script, temporary, env } = fixture(context);
  writeFileSync(
    script,
    `require('node:test').test('hung worker', (context) => {
${allocate}
context.signal.addEventListener('abort', () => process.exit(1));
setInterval(() => {}, 1000); return new Promise(() => {});
});`,
  );
  const child = spawnSync(process.execPath, [wrapper, "--test", "--test-timeout=1000", script], {
    env,
    encoding: "utf8",
  });
  assert.ifError(child.error);
  assert.notEqual(child.status, 0, child.stderr);
  assertRemoved(child.stdout);
  assert.deepEqual(readdirSync(temporary), []);
});

test("interrupted runner removes only its own root", {
  skip: process.platform === "win32",
}, async (context) => {
  const { script, temporary, env } = fixture(context);
  writeFileSync(join(temporary, "unowned"), "preserved");
  writeFileSync(script, allocate + "console.log('ready'); setInterval(() => {}, 1000);");
  const child = spawn(process.execPath, [wrapper, script], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGKILL"));
  await once(child.stdout, "data");
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
  assert.deepEqual(readdirSync(temporary), ["unowned"]);
  assert.equal(readFileSync(join(temporary, "unowned"), "utf8"), "preserved");
});

test("unit, coverage and Electron entry points always enable the per-run leak check", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const name of [
    "test",
    "test:watch",
    "test:coverage",
    "test:ci",
    "test:electron",
    "test:electron:affected",
    "test:packaged",
    "test:installers",
  ])
    assert.ok(scripts[name].startsWith("node scripts/test-temp.mjs "), name);
});

test("temporary fixtures cannot discover an enclosing worktree", (context) => {
  const { root, script, temporary, env } = fixture(context);
  gitHelper.gitSync(["init", "--quiet"], { cwd: root });
  writeFileSync(
    script,
    `
    const { gitSync } = require(${JSON.stringify(fileURLToPath(new URL("../tests/helpers/git.js", import.meta.url)))});
    const assert = require('node:assert/strict');
    assert.throws(() => gitSync(['rev-parse', '--show-toplevel'], { cwd: require('node:os').tmpdir(), stdio: 'pipe' }));
  `,
  );
  const child = spawnSync(process.execPath, [wrapper, script], { env, encoding: "utf8" });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(readdirSync(temporary), []);
});
