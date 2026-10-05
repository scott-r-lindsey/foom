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
