import { spawn } from "node:child_process";

interface LoginShellOptions {
  encoding: "utf8";
  timeout: number;
  maxBuffer: number;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/** Bounded login-shell reads must never acquire the application's controlling terminal. */
export function readLoginShell(
  shell: string,
  args: readonly string[],
  options: LoginShellOptions,
): Promise<{ stdout: string; stderr: string }> {
  if (options.signal?.aborted) return Promise.reject(new Error("Process read cancelled"));
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(shell, args, {
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
      detached,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let failure: Error | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const sizes = { stdout: 0, stderr: 0 };
    const kill = () => {
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group may already have exited (including after spawn failure).
        }
      } else {
        child.kill("SIGKILL");
      }
    };
    const abort = () => {
      failure = new Error("Process read cancelled");
      kill();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      failure = new Error("Login shell timed out");
      kill();
    }, options.timeout);
    const collect = (stream: "stdout" | "stderr", chunks: Buffer[], data: Buffer) => {
      sizes[stream] += data.length;
      if (sizes[stream] > options.maxBuffer) {
        failure ??= new Error("Login shell output limit exceeded");
        kill();
      } else chunks.push(data);
    };
    child.stdout.on("data", (data: Buffer) => {
      collect("stdout", stdout, data);
    });
    child.stderr.on("data", (data: Buffer) => {
      collect("stderr", stderr, data);
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("exit", () => {
      // A shell can exit while background children still hold the output pipes.
      kill();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error("Login shell failed"));
      else
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
  });
}
