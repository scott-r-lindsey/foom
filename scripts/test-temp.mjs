import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
const kill = (signal) => {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const stop = (signal) => {
  interrupted ??= signal;
  kill(signal);
  force ??= setTimeout(() => kill("SIGKILL"), 5000);
};
const groupExists = () => {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const waitForGroup = async () => {
  const deadline = Date.now() + 5000;
  while (groupExists()) {
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
  return true;
};
const drainGroup = async () => {
  // Windows has no negative-PID group probe; only the runner is guaranteed dead.
  if (process.platform === "win32" || !child?.pid || !groupExists()) return;
  kill("SIGTERM");
  if (await waitForGroup()) return;
  kill("SIGKILL");
  if (await waitForGroup()) return;
  throw new Error(
    `Test process group ${child.pid} survived SIGKILL; retaining temporary roots: ${roots.join(", ")}`,
  );
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
  // From here, exit-time deletion cannot safely assume descendants are dead.
  process.removeListener("exit", remove);
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
  try {
    await drainGroup();
    if (interrupted) process.exitCode = 128 + constants.signals[interrupted];
    remove();
    console.info("Test temp leak check: all owned run directories removed.");
  } finally {
    clearTimeout(force);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    process.removeListener("exit", remove);
  }
}
