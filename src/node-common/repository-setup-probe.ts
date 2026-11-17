import { spawn } from "node:child_process";
export class SetupProbeExit extends Error {
  constructor(readonly code: number | null) {
    super("Repository setup probe failed");
  }
}
/** Fixed read-only queries: bounded streams and group lifetime, no controlling terminal. */
export function setupProbe(
  command: string,
  args: readonly string[],
  home: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: home,
      env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let failure: Error | undefined;
    const chunks: Buffer[] = [];
    const sizes = { stdout: 0, stderr: 0 };
    const kill = () => {
      if (process.platform === "win32") child.kill("SIGKILL");
      else if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Group has already exited. */
        }
      }
    };
    const cancel = () => {
      failure = new Error("Repository setup probe cancelled");
      kill();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => {
      failure = new Error("Repository setup probe timed out");
      kill();
    }, 5000);
    const collect = (stream: "stdout" | "stderr", data: Buffer) => {
      sizes[stream] += data.length;
      if (sizes[stream] > 65536) {
        failure = new Error("Repository setup probe output exceeded");
        kill();
      } else if (stream === "stdout") chunks.push(data);
    };
    child.stdout.on("data", (data: Buffer) => {
      collect("stdout", data);
    });
    child.stderr.on("data", (data: Buffer) => {
      collect("stderr", data);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("exit", kill);
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (failure) reject(failure);
      else if (code !== 0) reject(new SetupProbeExit(code));
      else {
        try {
          resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        } catch {
          reject(new Error("Invalid repository setup probe output"));
        }
      }
    });
  });
}
