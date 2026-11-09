const { execFile } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { deadline } = require("./test-policy.js");

const properties = "ProcessId,ParentProcessId,Name,CreationDate,CommandLine";
// Restrict WMI's projection, not the process set or the fields used by the audit.
const command = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::Error.WriteLine('FOOM_AUDIT:ready')",
  `$rows = @(Get-CimInstance Win32_Process -Property ${properties})`,
  "[Console]::Error.WriteLine('FOOM_AUDIT:queried')",
  `$json = ConvertTo-Json -InputObject @($rows | Select-Object ${properties}) -Compress`,
  "[Console]::Error.WriteLine('FOOM_AUDIT:serialized')",
  "[Console]::Out.WriteLine($json)",
  "[Console]::Error.WriteLine('FOOM_AUDIT:written')",
].join("; ");

// Fixed phase names and byte counts only: process argv and PowerShell errors may
// contain private data. Keep the trace bounded even for malformed child output.
async function windowsProcessSnapshot(report = () => {}, execute = execFile) {
  const started = performance.now();
  const trace = [];
  const record = (phase) =>
    trace.push({ phase, elapsedMs: Math.round(performance.now() - started) });
  record("requested");
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let pending = "";
  const phases = ["ready", "queried", "serialized", "written"];
  let nextPhase = 0;
  let outcome;
  const stdout = await new Promise((resolve, reject) => {
    const child = execute(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { timeout: deadline(10_000), maxBuffer: 4 * 1024 * 1024 },
      (error, output) => {
        if (error) {
          outcome = {
            code: typeof error.code === "number" ? error.code : null,
            signal: error.signal === "SIGTERM" ? "SIGTERM" : null,
            killed: error.killed === true,
          };
          reject(new Error("Windows process snapshot command failed"));
        } else resolve(output);
      },
    );
    child.once("spawn", () => record("spawned"));
    child.once("exit", () => record("exited"));
    child.once("close", () => record("closed"));
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      for (const character of chunk.toString()) {
        if (character === "\n") {
          if (
            nextPhase < phases.length &&
            (pending === `FOOM_AUDIT:${phases[nextPhase]}\r` ||
              pending === `FOOM_AUDIT:${phases[nextPhase]}`)
          ) {
            record(phases[nextPhase++]);
          }
          pending = "";
        } else if (pending.length < 128) pending += character;
      }
    });
  }).catch(() => {
    report({ trace, stdoutBytes, stderrBytes, outcome, success: false });
    throw new Error(
      `Windows process snapshot failed: ${JSON.stringify({ trace, stdoutBytes, stderrBytes, outcome })}`,
    );
  });
  let rows;
  try {
    rows = JSON.parse(stdout);
    if (
      !Array.isArray(rows) ||
      !rows.length ||
      rows.some(
        (row) =>
          !row ||
          !Number.isInteger(row.ProcessId) ||
          !Number.isInteger(row.ParentProcessId) ||
          typeof row.Name !== "string" ||
          (row.CreationDate !== null && typeof row.CreationDate !== "string") ||
          (row.CommandLine !== null && typeof row.CommandLine !== "string"),
      )
    )
      throw new Error("Invalid process rows");
  } catch {
    report({ trace, stdoutBytes, stderrBytes, success: false });
    throw new Error("Windows process snapshot returned invalid process rows");
  }
  record("parsed");
  report({ trace, stdoutBytes, stderrBytes, success: true, processes: rows.length });
  return rows.map((entry) => ({
    pid: entry.ProcessId,
    parent: entry.ParentProcessId,
    name: entry.Name,
    start: entry.CreationDate,
    command: entry.CommandLine ?? "",
    host: /node.mojom.NodeService/.test(entry.CommandLine ?? ""),
  }));
}

module.exports = { windowsProcessSnapshot };
