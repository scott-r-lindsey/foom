const { test } = require("./test-shard.js");
const assert = require("node:assert/strict");
const { deadline } = require("./test-policy.js");

test("Windows projected snapshot measures enumeration and preserves this process identity", {
  skip: process.platform !== "win32",
  timeout: deadline(30_000),
}, async (context) => {
  const { execFile } = require("node:child_process");
  const { windowsProcessSnapshot } = require("./windows-process-snapshot.js");
  // Use the same bounded transport for the control, requesting every WMI property.
  const baselineRows = await windowsProcessSnapshot(
    (details) => context.diagnostic(`unprojected Windows snapshot: ${JSON.stringify(details)}`),
    (file, args, options, callback) => {
      const projection =
        "Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,CommandLine";
      assert.ok(args.some((arg) => arg.includes(projection)));
      return execFile(
        file,
        args.map((arg) => arg.replace(projection, "Win32_Process")),
        options,
        callback,
      );
    },
  );
  const baseline = baselineRows.find((row) => row.pid === process.pid);
  assert.ok(baseline);
  const rows = await windowsProcessSnapshot((details) =>
    context.diagnostic(`projected Windows snapshot: ${JSON.stringify(details)}`),
  );
  const own = rows.find((row) => row.pid === process.pid);
  assert.ok(own);
  assert.equal(own.pid, baseline.pid);
  assert.equal(own.parent, baseline.parent);
  assert.equal(own.name, baseline.name);
  assert.equal(own.start, baseline.start);
  assert.equal(own.host, baseline.host);
  assert.ok(
    own.command === baseline.command,
    "Projected snapshot must retain the full command line",
  );
});
