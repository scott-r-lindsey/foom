import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function fixture(context, normal = false) {
  const directory = mkdtempSync(join(tmpdir(), "foom-capture-signal-test-"));
  const owned = [];
  context.after(() => {
    for (const pid of owned) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const runner = join(directory, "runner.cjs");
  writeFileSync(
    runner,
    `
    const {mkdirSync} = require('node:fs');
    const {join} = require('node:path');
    const {spawn} = require('node:child_process');
    const root = process.env.TMPDIR;
    const paths = ['home', 'profile', 'fixture', 'isolation', 'entry'].map(name => join(root,name));
    for (const path of paths) mkdirSync(path);
    const ready = (pid) => console.log(JSON.stringify({root,paths,pid:process.pid,app:pid}));
    if (${normal}) { ready(null); process.exit(0); }
    else {
      process.on('SIGTERM', () => {});
      // Like Playwright's Electron, the app owns a separate process group.
      const app = spawn(process.execPath, ['-e',
        "process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},1000)"],
        {detached:true,stdio:['ignore','ignore','ignore','ipc']});
      app.once('message', () => ready(app.pid));
      setInterval(()=>{},1000);
    }
  `,
  );
  const driver = join(directory, "driver.mjs");
  writeFileSync(
    driver,
    `
    import {spawn} from 'node:child_process';
    import {runCapture} from ${JSON.stringify(new URL("./capture-session.mjs", import.meta.url).href)};
    process.exitCode = await runCapture({cwd:${JSON.stringify(directory)},
      launch: (_command, _args, options) => spawn(process.execPath, [${JSON.stringify(runner)}], options)});
  `,
  );
  const child = spawn(process.execPath, [driver], {
    env: { ...process.env, TMPDIR: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  owned.push(child.pid);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = once(child, "close");
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const ready = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) {
        const record = JSON.parse(output.split("\n")[0]);
        for (const pid of [record.pid, record.app]) if (pid) owned.push(pid);
        resolve(record);
      }
    });
    child.once("error", reject);
    child.once("exit", () => {
      if (!output.includes("\n")) reject(new Error(stderr));
    });
  });
  return { child, closed, ready, stderr: () => stderr };
}

function alive(pid) {
  try {
    return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
]) {
  test(`capture ${signal} kills detached app groups and removes every disposable directory`, {
    skip: process.platform !== "linux",
    timeout: 10000,
  }, async (context) => {
    const run = fixture(context);
    const { root, paths, pid, app } = await run.ready;
    assert.ok(existsSync(root));
    assert.ok(paths.every(existsSync));
    assert.ok(alive(app));
    run.child.kill(signal);
    assert.deepEqual(await run.closed, [code, null], run.stderr());
    assert.equal(existsSync(root), false);
    assert.ok(paths.every((path) => !existsSync(path)));
    assert.equal(alive(pid), false, "runner group survived cancellation");
    assert.equal(alive(app), false, "detached Electron-like group survived cancellation");
  });
}

test("normal capture exit also removes its entire temporary root", {
  skip: process.platform !== "linux",
  timeout: 10000,
}, async (context) => {
  const run = fixture(context, true);
  const { root } = await run.ready;
  assert.deepEqual(await run.closed, [0, null], run.stderr());
  assert.equal(existsSync(root), false);
});
