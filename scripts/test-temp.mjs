import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

// The parent owns this root, so a failed assertion, worker timeout or hard worker
// exit cannot skip cleanup. Never enumerate or sweep the shared temporary directory.
const root = mkdtempSync(join(tmpdir(), "foom-tests-"));
const remove = () => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  if (existsSync(root)) throw new Error(`Test temporary directory leaked: ${root}`);
};
process.once("exit", remove);
// An explicitly chosen TMPDIR may be inside a worktree. Stop Git discovery at
// this invalid gitfile, so non-repository fixtures cannot resolve the parent repo.
writeFileSync(join(root, ".git"), "Isolated test temporary directory\n");
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
  child = spawn(process.execPath, process.argv.slice(2), {
    stdio: "inherit",
    detached: process.platform !== "win32",
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
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
  console.info("Test temp leak check: owned run directory removed.");
}
