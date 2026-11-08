import { mkdtemp, open, rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export interface VendorScript {
  url: string;
  interpreter: "sh" | "bash";
  arguments: readonly string[];
}

/** HTTPS applies to every hop. The response is bounded before any byte is executed. */
export async function downloadVendorScript(
  address: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<Uint8Array> {
  let url = new URL(address);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("Installer requires HTTPS");
    const response = await request(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Installer redirect missing address");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("Installer download failed");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 2 * 1024 * 1024) throw new Error("Installer download too large");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    if (!size) throw new Error("Installer download empty");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  throw new Error("Too many installer redirects");
}

/** Foom calls this from Settings recipes; the helper is not an OS authorization boundary. */
export async function runVendorScript(
  script: VendorScript,
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  process.stdout.write(`Download ${script.url}\n`);
  const abort = new AbortController();
  let child: ChildProcess | undefined;
  let childClosed = false;
  let interrupted: NodeJS.Signals | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const terminate = (signal: NodeJS.Signals) => {
    if (!child?.pid) return;
    if (process.platform === "win32") child.kill(signal);
    else {
      try {
        // The interpreter owns a separate group, including vendor descendants.
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
          child.kill(signal);
      }
    }
  };
  const stop = (signal: NodeJS.Signals) => {
    interrupted ??= signal;
    abort.abort();
    terminate(childClosed ? "SIGKILL" : signal);
    if (childClosed) return;
    // Finish before TerminalManager.stopSession's one-second helper kill fallback.
    escalation ??= setTimeout(() => {
      terminate("SIGKILL");
    }, 250);
    escalation.unref();
  };
  const signals: readonly NodeJS.Signals[] =
    process.platform === "win32"
      ? ["SIGHUP", "SIGINT", "SIGTERM"]
      : ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"];
  const handlers = signals.map((signal) => {
    const handler = () => {
      stop(signal);
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  const status = () => (interrupted ? 128 + constants.signals[interrupted] : 1);
  let directory: string | undefined;
  let outcome = 1;
  try {
    const bytes = await downloadVendorScript(
      script.url,
      AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
    );
    abort.signal.throwIfAborted();
    directory = await mkdtemp(join(tmpdir(), "foom-installer-"));
    const path = join(directory, "install.sh");
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    abort.signal.throwIfAborted();
    outcome = await new Promise<number>((resolve) => {
      child = spawn(`/bin/${script.interpreter}`, [path, ...script.arguments], {
        cwd: home,
        env,
        shell: false,
        stdio: "inherit",
        detached: process.platform !== "win32",
      });
      let failed = false;
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (code, signal: NodeJS.Signals | null) => {
        childClosed = true;
        resolve(
          interrupted
            ? status()
            : failed
              ? 1
              : (code ?? (signal ? 128 + constants.signals[signal] : 1)),
        );
      });
    });
  } catch {
    if (!interrupted) process.stderr.write("Installer download or execution failed\n");
  } finally {
    try {
      // On interruption, descendants may outlive an interpreter that accepted the signal.
      if (interrupted) terminate("SIGKILL");
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        clearTimeout(escalation);
        for (const { signal, handler } of handlers) process.removeListener(signal, handler);
      }
    }
  }
  return interrupted ? status() : outcome;
}
