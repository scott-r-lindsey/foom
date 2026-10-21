import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import audit from "../tests/electron/process-audit.js";

// Mock only the polling clock; snapshot promises remain explicitly controlled.
test("idle audit finish cancels its timer and still checks survivors", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let snapshots = 0;
  const scope = await audit.auditProcesses(context, undefined, async () => {
    snapshots++;
    return [];
  });
  await scope.finish();
  assert.equal(snapshots, 2);
  context.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(snapshots, 2, "cancelled poll must not take another snapshot");
});

for (const outcome of ["success", "failure", "violation"]) {
  test(`audit finish awaits an in-flight capture: ${outcome}`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const captured = Promise.withResolvers();
    const started = Promise.withResolvers();
    let snapshots = 0;
    const scope = await audit.auditProcesses(context, undefined, async () => {
      snapshots++;
      if (snapshots === 2) {
        started.resolve();
        return captured.promise;
      }
      return [];
    });
    scope.add(123);
    scope.forbidAgentsOutside(new Set());
    context.mock.timers.tick(1000);
    await started.promise;
    let finished = false;
    const finishing = scope.finish().finally(() => {
      finished = true;
    });
    await Promise.resolve();
    assert.equal(finished, false);
    assert.equal(snapshots, 2, "survivor check must wait for capture");
    if (outcome === "failure") {
      const error = new Error("snapshot failed");
      const rejected = assert.rejects(finishing, (actual) => actual === error);
      captured.reject(error);
      await rejected;
      assert.equal(snapshots, 2);
    } else {
      const rejected =
        outcome === "violation"
          ? assert.rejects(finishing, /Test started an agent outside its fixtures/)
          : finishing;
      captured.resolve(
        outcome === "violation"
          ? [
              {
                pid: 123,
                parent: 1,
                start: "new",
                name: "node",
                command: `${process.cwd()}/agy`,
              },
            ]
          : [],
      );
      await rejected;
      assert.equal(snapshots, 3);
    }
  });
}

test("process ancestry includes grandchildren in any order, excluding unrelated trees", () => {
  const rows = [
    { pid: 3, parent: 2 },
    { pid: 9, parent: 8 },
    { pid: 2, parent: 1 },
    { pid: 1, parent: 0 },
  ];
  assert.deepEqual(
    audit.descendants(rows, [1]).map((row) => row.pid),
    [3, 2, 1],
  );
});

test("PID reuse never adopts processes that existed before the test", () => {
  const oldChild = { pid: 20, parent: 10, start: "old" };
  const oldGrandchild = { pid: 30, parent: 20, start: "old" };
  const rows = [
    oldChild,
    oldGrandchild,
    { pid: 10, parent: 1, start: "new" },
    { pid: 40, parent: 10, start: "new" },
    // A baseline PID may legitimately be reused by a new app child.
    { pid: 50, parent: 40, start: "new" },
  ];
  const baseline = [oldChild, oldGrandchild, { pid: 50, parent: 1, start: "old" }];
  assert.deepEqual(
    audit.descendants(rows, [10], baseline).map((row) => row.pid),
    [10, 40, 50],
  );
});

test("process audit detects a live descendant and accepts it after exit", async (context) => {
  const checkpoints = [];
  const scope = await audit.auditProcesses(context, (stage, details) =>
    checkpoints.push({ stage, ...details }),
  );
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  context.after(() => child.kill());
  await once(child, "spawn");
  scope.add(child.pid);
  await scope.capture();
  await assert.rejects(scope.finish(), /Test left app, utility-host or shell processes alive/);
  const exited = once(child, "exit");
  child.kill();
  await exited;
  await scope.finish();
  assert.ok(
    checkpoints.some(
      (row) =>
        row.stage === "process audit capture" &&
        row.processes.some((process) => process.pid === child.pid),
    ),
  );
  assert.ok(checkpoints.every((row) => !JSON.stringify(row).includes("command")));
  assert.deepEqual(checkpoints.at(-1), { stage: "process audit survivors", processes: [] });
});

test("agent guard permits fixtures and rejects outside paths and escaping symlinks", async (context) => {
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { assertFixtureAgent } = await import("../tests/electron/agent-isolation.js");
  const root = await mkdtemp(path.join(tmpdir(), "foom-agent-guard-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, "fixture");
  const outside = path.join(root, "fixture-other");
  await mkdir(fixture);
  await mkdir(outside);
  for (const name of ["claude", "codex.exe", "agy", "copilot", "gh", "glab"]) {
    await writeFile(path.join(fixture, name), "fixture");
    await writeFile(path.join(outside, name), "outside");
    assertFixtureAgent(path.join(fixture, name), [fixture]);
    assert.throws(
      () => assertFixtureAgent(path.join(outside, name), [fixture]),
      /Agent outside test fixtures/,
    );
  }
  if (process.platform !== "win32") {
    await symlink(path.join(outside, "agy"), path.join(fixture, "codex"));
    assert.throws(
      () => assertFixtureAgent(path.join(fixture, "codex"), [fixture]),
      /Agent outside test fixtures/,
    );
  }
});

test("fixture login shell ignores inherited PATH and never exposes Node's sibling CLIs", {
  skip:
    process.platform === "win32" && "Windows discovery uses inherited PATH without a login shell",
}, async (context) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { isolatedEnvironment } = await import("../tests/electron/agent-isolation.js");
  const root = await mkdtemp(path.join(tmpdir(), "foom-login-shell-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = await isolatedEnvironment(root, ["/usr/bin", "/bin"].join(path.delimiter));
  const output = execFileSync(env.SHELL, ["-ilc", 'printf "\\000FOOM_PATH\\000%s\\000" "$PATH"'], {
    env: { ...process.env, PATH: "/host/agents" },
  }).toString();
  assert.equal(output, `\0FOOM_PATH\0${env.PATH}\0`);
  assert.throws(
    () => execFileSync(path.join(root, "bin", "gh"), ["auth", "status"]),
    (error) => error.status === 1,
  );
  assert.deepEqual(env.PATH.split(path.delimiter), [path.join(root, "bin"), "/usr/bin", "/bin"]);
  assert.equal(
    execFileSync(path.join(root, "bin", "node"), ["--version"])
      .toString()
      .trim(),
    process.version,
  );
});

test("probe guard records and blocks a short-lived outside CLI before it can execute", async (context) => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = await mkdtemp(path.join(tmpdir(), "foom-blocked-probe-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, "agy");
  const log = path.join(root, "guard.log");
  await writeFile(cli, "This must never execute");
  const guard = path.resolve("tests/electron/agent-isolation.js");
  for (const method of ["execFile", "spawn"]) {
    const program = `require(${JSON.stringify(guard)}).guardAgentProbes([], ${JSON.stringify(log)});
      try { require("node:child_process")[${JSON.stringify(method)}](${JSON.stringify(cli)}, ["plugin", "list"]); }
      catch (error) { if (error.message.includes("Agent outside test fixtures")) process.exit(0); }
      process.exit(1);`;
    execFileSync(process.execPath, ["-e", program]);
  }
  assert.match(await readFile(log, "utf8"), /Agent outside test fixtures/);
});

test("process audit retains an outside agent violation after the process exits", async (context) => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "foom-audit-agent-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cli = path.join(root, "agy");
  await writeFile(cli, "setInterval(() => {}, 1000)");
  const scope = await audit.auditProcesses(context);
  scope.forbidAgentsOutside(new Set());
  // Harmless synthetic CLI, never the developer's executable.
  const child = spawn(process.execPath, [cli], { stdio: "ignore" });
  context.after(() => child.kill());
  await once(child, "spawn");
  scope.add(child.pid);
  await scope.capture();
  const exited = once(child, "exit");
  child.kill();
  await exited;
  await assert.rejects(scope.finish(), /Test started an agent outside its fixtures/);
});

test("smoke checkpoints survive abrupt worker exit without recording environment", async (context) => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "foom-smoke-diagnostics-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "nested", "worker.jsonl");
  const helper = resolve("tests/electron/smoke-diagnostics.js");
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const checkpoint = require(${JSON.stringify(helper)}).smokeDiagnostics(${JSON.stringify(file)});
    checkpoint("disconnect CDP", { appPid: 123 });
    process.exit(7);
  `,
    ],
    { env: { ...process.env, FOOM_DIAGNOSTIC_SECRET: "must-not-record-this" } },
  );
  assert.equal(result.status, 7);
  const text = await readFile(file, "utf8");
  assert.ok(!text.includes("must-not-record-this"));
  const rows = text.trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    rows.map((row) => row.stage),
    ["worker started", "disconnect CDP", "worker exit"],
  );
  assert.equal(rows[1].appPid, 123);
  assert.equal(rows[2].code, 7);
  assert.equal(typeof rows[1].resources, "object");
  assert.deepEqual(rows[1].nativeModules, []);
});

test("agent guard compares native Windows aliases and still rejects outside targets", async () => {
  const { readFile } = await import("node:fs/promises");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { runInNewContext } = await import("node:vm");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const source = await readFile(
    new URL("../tests/electron/agent-isolation.js", import.meta.url),
    "utf8",
  );
  const short = path.win32.join("C:\\Users", "RUNNER~1", "Temp", "fixture");
  const canonical = short.replace("RUNNER~1", "runneradmin");
  const outside = `${canonical}-other`;
  // The JS realpath implementation can retain a Windows short-name spelling.
  // Native executable discovery expands it; model both spellings on every OS.
  const realpathSync = (file) => file;
  realpathSync.native = (file) =>
    file.endsWith("codex.exe")
      ? path.win32.join(outside, "codex.exe")
      : file.replace("RUNNER~1", "runneradmin");
  const module = { exports: {} };
  runInNewContext(source, {
    module,
    require: (name) =>
      name === "node:path"
        ? path.win32
        : name === "node:fs"
          ? { ...fs, realpathSync }
          : require(name),
  });
  const { assertFixtureAgent } = module.exports;
  assertFixtureAgent(path.win32.join(canonical, "gh.exe"), [short]);
  assertFixtureAgent(path.win32.join(short, "gh.exe"), [canonical]);
  assert.throws(
    () => assertFixtureAgent(path.win32.join(outside, "gh.exe"), [short]),
    /Agent outside test fixtures/,
  );
  // A canonicalized escaping symlink must remain outside, even through an alias.
  assert.throws(
    () => assertFixtureAgent(path.win32.join(short, "codex.exe"), [short]),
    /Agent outside test fixtures/,
  );
});
