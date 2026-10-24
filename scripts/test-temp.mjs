import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The parent owns these roots, so a failed assertion, worker timeout or hard worker
// exit cannot skip cleanup. Never enumerate or sweep the shared temporary directory.
const roots = [];
const remove = () => {
  const failures = [];
  for (const directory of roots) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
      if (existsSync(directory)) throw new Error(`Test temporary directory leaked: ${directory}`);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Test temporary cleanup failed");
};
process.once("exit", remove);
const allocate = (parent, prefix) => {
  const directory = mkdtempSync(join(parent, prefix));
  roots.push(directory);
  // Stop Git discovery when the chosen temporary parent is inside a worktree.
  writeFileSync(join(directory, ".git"), "Isolated test temporary directory\n");
  return directory;
};
const root = allocate(tmpdir(), "foom-tests-");
let child;
let force;
let interrupted;
const stop = (signal) => {
  interrupted ??= signal;
  const kill = (next) => {
    if (!child?.pid) return;
    try {
      // Include test workers when the runner is interrupted on Unix.
      if (process.platform === "win32") child.kill(next);
      else process.kill(-child.pid, next);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  kill(signal);
  force ??= setTimeout(() => kill("SIGKILL"), 5000);
};
const handlers = new Map(
  ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, () => stop(signal)]),
);
for (const [signal, handler] of handlers) process.on(signal, handler);
try {
  // Keep the concurrent-review fixture on the worktree filesystem, and browser
  // storage on tmpfs when available. Their parent survives a killed test worker.
  mkdirSync("test-results", { recursive: true });
  const disk = allocate(resolve("test-results"), "foom-tests-disk-");
  let shared;
  if (process.platform === "linux") {
    try {
      const filesystem = statfsSync("/dev/shm");
      if (
        filesystem.type === 0x01021994 &&
        filesystem.bavail * filesystem.bsize >= 128 * 1024 * 1024
      )
        shared = allocate("/dev/shm", "foom-tests-shm-");
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "ENOSPC", "EROFS"].includes(error.code)) throw error;
    }
  }
  child = spawn(process.execPath, process.argv.slice(2), {
    stdio: "inherit",
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      FOOM_TEST_DISK_ROOT: disk,
      FOOM_TEST_SHARED_MEMORY_ROOT: shared ?? root,
    },
  });
  const [code, signal] = await once(child, "exit");
  process.exitCode = interrupted
    ? 128 + constants.signals[interrupted]
    : (code ?? 128 + (constants.signals[signal] ?? 1));
} finally {
  clearTimeout(force);
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  remove();
  process.removeListener("exit", remove);
  console.info("Test temp leak check: all owned run directories removed.");
}
