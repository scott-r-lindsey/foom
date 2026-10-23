import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

function descendants(pid) {
  try {
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    return children.flatMap((child) => [...descendants(child), child]);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    return [];
  }
}

// Playwright gives Electron its own process group. Kill descendants' groups as
// well as the runner's group before removing files, including during startup.
function killCapture(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
}

export async function runCapture({ cwd, launch = spawn }) {
  let root;
  let child;
  let stopping = false;
  const remove = () => {
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  };
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    try {
      if (child?.pid) {
        // Record detached groups before their parents can exit and orphan them.
        const pids = [...descendants(child.pid), child.pid];
        killCapture(pids, "SIGTERM");
        // Give every descendant (including Xvfb) time to remove sockets/locks,
        // even if its parent has already exited. Stubborn groups are then killed.
        const deadline = Date.now() + 1000;
        const running = (pid) => {
          try {
            return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
          } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
            return false;
          }
        };
        while (pids.some(running) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        killCapture(pids, "SIGKILL");
      }
    } finally {
      remove();
      process.exit(128 + constants.signals[signal]);
    }
  };
  const handlers = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
      signal,
      () => {
        void stop(signal);
      },
    ]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    root = mkdtempSync(join(tmpdir(), "foom-capture-"));
    child = launch(
      "xvfb-run",
      [
        "-a",
        "--server-args=-screen 0 1600x1000x24 -dpi 96",
        process.execPath,
        "--require",
        "./tests/helpers/setup.js",
        "--test",
        "tests/electron/product-shots.js",
      ],
      {
        cwd,
        stdio: "inherit",
        detached: true,
        // Every harness mkdtemp, including home, profile, CLI isolation and entry
        // fixtures, is contained here. xvfb-run's authority file is here too.
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root, FOOM_ELECTRON_SHARD: "" },
      },
    );
    const [code, signal] = await once(child, "exit");
    return code ?? 128 + (constants.signals[signal] ?? 1);
  } finally {
    if (!stopping) {
      remove();
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    }
  }
}
