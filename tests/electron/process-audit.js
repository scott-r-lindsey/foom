const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const { deadline } = require("./test-policy.js");
const run = promisify(execFile);

async function snapshot() {
  if (process.platform === "win32") {
    const { stdout } = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Compress",
      ],
      { timeout: deadline(10_000), maxBuffer: 4 * 1024 * 1024 },
    );
    return JSON.parse(stdout).map((entry) => ({
      pid: entry.ProcessId,
      parent: entry.ParentProcessId,
      name: entry.Name,
      start: entry.CreationDate,
      host: /node.mojom.NodeService/.test(entry.CommandLine ?? ""),
    }));
  }
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,lstart=,comm=,args="], {
    timeout: deadline(10_000),
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      return {
        pid: Number(fields[0]),
        parent: Number(fields[1]),
        start: fields.slice(2, 7).join(" "),
        name: fields[7],
        host: /node.mojom.NodeService/.test(fields.slice(8).join(" ")),
      };
    });
}

function descendants(rows, roots) {
  const ids = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (ids.has(row.parent) && !ids.has(row.pid)) {
        ids.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => ids.has(row.pid));
}

// Capture descendants while the app is alive, retaining their creation identity
// after reparenting. Never kill a process solely because its PID was reused.
async function auditProcesses(context) {
  const roots = new Set();
  const tracked = new Map();
  const baseline = await snapshot();
  const counts = { electron: 0, host: 0, shell: 0 };
  for (const row of baseline) {
    if (/electron|foom/i.test(row.name)) counts.electron++;
    if (row.host || /pty|OpenConsole/i.test(row.name)) counts.host++;
    if (/powershell|cmd.exe|bash|zsh/i.test(row.name)) counts.shell++;
  }
  context.diagnostic(`process counts before: ${JSON.stringify(counts)}`);
  let stopped = false;
  let failure;
  const capture = async () => {
    for (const row of descendants(await snapshot(), roots)) tracked.set(row.pid, row);
  };
  const polling = (async () => {
    while (!stopped) {
      await delay(1000);
      if (!stopped) await capture();
    }
  })().catch((error) => {
    failure = error;
  });
  return {
    add(pid) {
      roots.add(pid);
    },
    capture,
    async finish() {
      stopped = true;
      await polling;
      if (failure) throw failure;
      const until = Date.now() + deadline(10_000);
      let survivors;
      do {
        survivors = (await snapshot()).filter((row) => tracked.get(row.pid)?.start === row.start);
        if (!survivors.length) break;
        await delay(100);
      } while (Date.now() < until);
      context.diagnostic(`processes after: ${JSON.stringify(survivors)}`);
      assert.deepEqual(survivors, [], "Test left app, utility-host or shell processes alive");
    },
  };
}
module.exports = { auditProcesses, descendants };
