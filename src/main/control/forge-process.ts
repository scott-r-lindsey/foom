import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { ForgeResponse } from "./forge.d";
import type { ForgeExecutionState } from "./forge-lifecycle-types";

export class ForgeExecutionError extends Error {
  constructor(readonly state: Exclude<ForgeExecutionState, "ready">) {
    super(`Forge ${state}`);
  }
}

/** Same native-only PATH policy as agents; no cwd lookup or Windows shell wrappers. */
export async function resolveForgeExecutable(names: readonly string[], path: string) {
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(name) || /\.(cmd|bat|ps1)$/iu.test(name))
      throw new ForgeExecutionError("unavailable");
    for (const directory of path.split(delimiter)) {
      if (!isAbsolute(directory)) continue;
      for (const suffix of process.platform === "win32" ? [".exe", ".com", ""] : [""]) {
        try {
          const executable = await realpath(join(directory, name + suffix));
          if (process.platform === "win32" && !/\.(exe|com)$/iu.test(executable)) continue;
          await access(executable, constants.X_OK);
          const info = await stat(executable);
          if (!info.isFile()) continue;
          return {
            executable,
            identity: JSON.stringify([
              executable,
              info.dev,
              info.ino,
              info.size,
              info.mtimeMs,
              info.ctimeMs,
            ]),
          };
        } catch {
          // A missing or non-executable candidate does not shadow later PATH entries.
        }
      }
    }
  }
  throw new ForgeExecutionError("unavailable");
}

/** Never retains an Error cause: execFile errors contain raw CLI output and environment data. */
export function executeForge(
  executable: string,
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<ForgeResponse> {
  if (signal.aborted) return Promise.reject(new ForgeExecutionError("cancelled"));
  const systemRoot = process.env["SystemRoot"] ?? "";
  if (process.platform === "win32" && (!systemRoot || !isAbsolute(systemRoot)))
    return Promise.reject(new ForgeExecutionError("unavailable"));
  return new Promise((resolve, reject) => {
    let stopped = false;
    let cleanup: Promise<void> | undefined;
    let bytes = 0;
    let stdout = "";
    let stderr = "";
    let failed = false;
    const child = spawn(executable, [...argv], {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      void (async () => {
        await cleanup;
        if (stopped || failed || code === null)
          reject(new ForgeExecutionError(signal.aborted ? "cancelled" : "unavailable"));
        else resolve({ code, stdout, stderr });
      })();
    });
    const stop = () => {
      if (stopped) return;
      stopped = true;
      const pid = child.pid;
      if (!pid) return;
      if (process.platform === "win32") {
        // Fixed OS executable and arguments, never PATH or a command shell.
        const root = systemRoot;
        cleanup = new Promise<void>((done) => {
          execFile(
            join(root, "System32", "taskkill.exe"),
            ["/pid", String(pid), "/T", "/F"],
            { windowsHide: true, timeout: 5000 },
            () => {
              child.kill("SIGKILL");
              done();
            },
          );
        });
      } else {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const abort = () => {
      stop();
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (chunk: string, output: "stdout" | "stderr") => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 256 * 1024) stop();
      else if (output === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", (chunk: string) => {
      collect(chunk, "stdout");
    });
    child.stderr.on("data", (chunk: string) => {
      collect(chunk, "stderr");
    });
    if (signal.aborted) stop();
  });
}
