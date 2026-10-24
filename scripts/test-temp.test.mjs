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
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import gitHelper from "../tests/helpers/git.js";

const wrapper = fileURLToPath(new URL("./test-temp.mjs", import.meta.url));
function fixture(context, beforeRemove) {
  const root = mkdtempSync(join(tmpdir(), "foom-temp-check-"));
  context.after(async () => {
    await beforeRemove?.();
    rmSync(root, { recursive: true, force: true });
  });
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

for (const exitCode of [0, 7, "SIGTERM"]) {
  test(`cleanup waits for a SIGTERM-ignoring group worker after ${exitCode}`, {
    skip: process.platform === "win32",
  }, async (context) => {
    let child;
    let output = "";
    let workerFinished = false;
    const { root, script, temporary, env } = fixture(context, async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      if (!workerFinished && existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        const deadline = Date.now() + 5000;
        for (;;) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (error.code === "ESRCH") break;
            throw error;
          }
          if (Date.now() >= deadline) throw Error(`Fixture worker ${pid} survived SIGKILL`);
          await delay(25);
        }
      }
      const match = output.match(/FOOM_TEST_ROOTS (\[[^\n]*\])/);
      if (match) {
        for (const directory of JSON.parse(match[1]).filter(Boolean))
          rmSync(directory, { recursive: true, force: true });
      }
    });
    const pidFile = join(root, "worker-pid");
    const removals = join(root, "removals");
    const preload = join(root, "observe-removal.cjs");
    writeFileSync(
      preload,
      `
const fs = require('node:fs');
const original = fs.rmSync;
fs.rmSync = (directory, options) => {
  const pid = Number(fs.readFileSync(${JSON.stringify(pidFile)}, 'utf8'));
  let dead = false;
  try { process.kill(pid, 0); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    dead = true;
  }
  fs.appendFileSync(${JSON.stringify(removals)}, JSON.stringify({ directory, dead }) + String.fromCharCode(10));
  if (!dead) throw Error('Root removed while worker alive');
  return original(directory, options);
};
require('node:module').syncBuiltinESMExports();
`,
    );
    const worker = `
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {
  fs.mkdirSync(process.env.TMPDIR, { recursive: true });
  fs.writeFileSync(require('node:path').join(process.env.TMPDIR, 'worker'), 'alive');
}, 50);
process.send('ready');
`;
    writeFileSync(
      script,
      allocate +
        `
const worker = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
worker.once('message', () => {
  worker.disconnect();
  worker.unref();
  writeSync(1, 'WORKER_READY' + String.fromCharCode(10));
  ${exitCode === "SIGTERM" ? "setInterval(() => {}, 1000);" : `process.exit(${exitCode});`}
});
`,
    );
    child = spawn(process.execPath, ["--require", preload, wrapper, script], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    const exited = once(child, "exit");
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("WORKER_READY")) resolve();
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`Exited before ready: ${errors}`)));
    });
    if (exitCode === "SIGTERM") child.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(signal, null, errors);
    assert.equal(code, exitCode === "SIGTERM" ? 143 : exitCode, errors);
    workerFinished = true;
    const observations = readFileSync(removals, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(observations.length >= 2);
    for (const observation of observations) assert.equal(observation.dead, true);
    assertRemoved(output);
    assert.deepEqual(readdirSync(temporary), []);
    assert.match(output, /Test temp leak check/);
  });
}

test("an undrained process group fails loudly and retains its roots", {
  skip: process.platform === "win32",
}, (context) => {
  const { root, script, env } = fixture(context);
  const preload = join(root, "persistent-group.cjs");
  // Simulate a group surviving SIGKILL without leaving an actual live process.
  writeFileSync(
    preload,
    `
const kill = process.kill;
process.kill = (pid, signal) => pid < 0 ? true : kill(pid, signal);
`,
  );
  writeFileSync(script, allocate);
  const child = spawnSync(process.execPath, ["--require", preload, wrapper, script], {
    env,
    encoding: "utf8",
  });
  assert.ifError(child.error);
  const roots = JSON.parse(child.stdout.match(/FOOM_TEST_ROOTS (\[[^\n]*\])/)[1]);
  context.after(() => {
    for (const directory of roots.filter(Boolean))
      rmSync(directory, { recursive: true, force: true });
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /survived SIGKILL; retaining temporary roots/);
  assert.doesNotMatch(child.stdout, /all owned run directories removed/);
  for (const directory of roots.filter(Boolean)) assert.equal(existsSync(directory), true);
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
