const { execFile } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { deadline } = require("./test-policy.js");

const properties = "ProcessId,ParentProcessId,Name,CreationDate,CommandLine";
// Restrict WMI's projection, not the process set or the fields used by the audit.
const command = [
  "$ErrorActionPreference = 'Stop'",
  "$foomAuditClock = [Diagnostics.Stopwatch]::StartNew()",
  "[Console]::Error.WriteLine('FOOM_AUDIT:ready:' + $foomAuditClock.ElapsedMilliseconds)",
  `$rows = @(Get-CimInstance Win32_Process -Property ${properties})`,
  "[Console]::Error.WriteLine('FOOM_AUDIT:queried:' + $foomAuditClock.ElapsedMilliseconds)",
  `$json = ConvertTo-Json -InputObject @($rows | Select-Object ${properties}) -Compress`,
  "[Console]::Error.WriteLine('FOOM_AUDIT:serialized:' + $foomAuditClock.ElapsedMilliseconds)",
  "[Console]::Out.WriteLine($json)",
  "[Console]::Error.WriteLine('FOOM_AUDIT:written:' + $foomAuditClock.ElapsedMilliseconds)",
].join("; ");

// Fixed phase names and byte counts only: process argv and PowerShell errors may
// contain private data. Keep the trace bounded even for malformed child output.
let snapshotSequence = 0;

class SnapshotCommandError extends Error {
  constructor(details, retryable) {
    super(`Windows process snapshot failed: ${JSON.stringify(details)}`);
    this.retryable = retryable;
  }
}

async function windowsSnapshotAttempt(
  report = () => {},
  execute = execFile,
  timeout = deadline(10_000),
) {
  const started = performance.now();
  const trace = [];
  const record = (phase, scriptElapsedMs) =>
    trace.push({
      phase,
      elapsedMs: Math.round(performance.now() - started),
      ...(scriptElapsedMs === undefined ? {} : { scriptElapsedMs }),
    });
  record("requested");
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let pending = "";
  const phases = ["ready", "queried", "serialized", "written"];
  let nextPhase = 0;
  let outcome;
  let retryable = false;
  const stdout = await new Promise((resolve, reject) => {
    const child = execute(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { timeout, maxBuffer: 4 * 1024 * 1024 },
      (error, output) => {
        if (error) {
          retryable =
            error.code === null &&
            error.killed === true &&
            error.signal === "SIGTERM" &&
            stdoutBytes === 0;
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
      stdoutBytes += Buffer.byteLength(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      for (const character of chunk.toString()) {
        if (character === "\n") {
          const marker = /^FOOM_AUDIT:(ready|queried|serialized|written):(\d{1,8})\r?$/.exec(
            pending,
          );
          if (nextPhase < phases.length && marker?.[1] === phases[nextPhase]) {
            record(phases[nextPhase++], Number(marker[2]));
          }
          pending = "";
        } else if (pending.length < 128) pending += character;
      }
    });
  }).catch(() => {
    report({ trace, stdoutBytes, stderrBytes, outcome, success: false });
    throw new SnapshotCommandError({ trace, stdoutBytes, stderrBytes, outcome }, retryable);
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

// Retry only the observed empty-output killed-command transport timeout, never malformed data
// or any audit assertion. Both attempts share the original snapshot budget.
async function windowsProcessSnapshot(
  report = () => {},
  execute = execFile,
  now = () => performance.now(),
) {
  const snapshotId = ++snapshotSequence;
  const budgetMs = deadline(10_000);
  const until = now() + budgetMs;
  const capture = (attempt, timeoutMs) =>
    windowsSnapshotAttempt(
      (details) => report({ snapshotId, attempt, budgetMs, timeoutMs, ...details }),
      execute,
      timeoutMs,
    );
  try {
    return await capture(1, Math.floor(budgetMs / 2));
  } catch (error) {
    const remaining = Math.floor(until - now());
    if (!(error instanceof SnapshotCommandError) || !error.retryable || remaining <= 0) throw error;
    return capture(2, remaining);
  }
}

module.exports = { windowsProcessSnapshot, windowsSnapshotAttempt };
