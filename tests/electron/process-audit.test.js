const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { deadline } = require("./test-policy.js");

test("Windows projected snapshot measures enumeration and preserves this process identity", {
  skip: process.platform !== "win32",
  timeout: deadline(30_000),
}, async (context) => {
  const { promisify } = require("node:util");
  const { execFile } = require("node:child_process");
  const { performance } = require("node:perf_hooks");
  const { windowsProcessSnapshot } = require("./windows-process-snapshot.js");
  const started = performance.now();
  const { stdout } = await promisify(execFile)(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Compress",
    ],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  )
    .catch(() => {
      throw new Error("Unprojected Windows snapshot comparison command failed");
    })
    .finally(() => {
      context.diagnostic(
        `unprojected Windows snapshot elapsedMs: ${Math.round(performance.now() - started)}`,
      );
    });
  let baseline;
  try {
    baseline = JSON.parse(stdout).find((row) => row.ProcessId === process.pid);
  } catch {
    throw new Error("Unprojected Windows snapshot comparison returned invalid rows");
  }
  assert.ok(baseline);
  const rows = await windowsProcessSnapshot((details) =>
    context.diagnostic(`projected Windows snapshot: ${JSON.stringify(details)}`),
  );
  const own = rows.find((row) => row.pid === process.pid);
  assert.ok(own);
  assert.equal(own.pid, baseline.ProcessId);
  assert.equal(own.parent, baseline.ParentProcessId);
  assert.equal(own.name, baseline.Name);
  assert.equal(own.start, baseline.CreationDate);
  assert.equal(own.host, /node.mojom.NodeService/.test(baseline.CommandLine));
  assert.ok(
    own.command === baseline.CommandLine,
    "Projected snapshot must retain the full command line",
  );
});
