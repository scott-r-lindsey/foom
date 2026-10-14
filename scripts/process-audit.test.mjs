import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import audit from "../tests/electron/process-audit.js";

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
  const scope = await audit.auditProcesses(context);
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
  for (const name of ["claude", "codex.exe", "agy"]) {
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
  const env = await isolatedEnvironment(root);
  const output = execFileSync(env.SHELL, ["-ilc", 'printf "\\000FOOM_PATH\\000%s\\000" "$PATH"'], {
    env: { ...process.env, PATH: "/host/agents" },
  }).toString();
  assert.equal(output, `\0FOOM_PATH\0${env.PATH}\0`);
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
  const program = `require(${JSON.stringify(guard)}).guardAgentProbes([], ${JSON.stringify(log)});
    try { require("node:child_process").execFile(${JSON.stringify(cli)}, ["plugin", "list"]); }
    catch (error) { if (error.message.includes("Agent outside test fixtures")) process.exit(0); }
    process.exit(1);`;
  execFileSync(process.execPath, ["-e", program]);
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
