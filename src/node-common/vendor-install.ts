import { mkdtemp, open, rm } from "node:fs/promises";
import { constants, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

// Installation needs account/desktop conventions, never the parent's agent or
// control credentials. Do not copy arbitrary login-shell or Environment values.
const inheritedNames = new Set([
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "ZDOTDIR",
  "XDG_BIN_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_DIRS",
  "XDG_DATA_DIRS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
]);

/** Complete environment for explicit vendor/package-manager installation only. */
export function installerEnvironment(
  home: string,
  source: NodeJS.ProcessEnv,
  path = source["PATH"],
): Record<string, string> {
  const account = userInfo();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source))
    if (value && (inheritedNames.has(name) || /^LC_[A-Z_]+$/u.test(name))) env[name] = value;
  return {
    ...env,
    HOME: home,
    USER: account.username,
    LOGNAME: account.username,
    SHELL: source["SHELL"] || account.shell || "/bin/sh",
    PATH: path || "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: env["TMPDIR"] || tmpdir(),
    LANG: env["LANG"] || "C",
  };
}

// Fixed source only; vendor values are positional argv, never shell source.
// The watcher reads the helper's lifetime pipe while the interpreter is running.
// It kills its own group (0), so cleanup never addresses a possibly reused PGID.
const installerSupervisor = `set +em
trap 'kill -KILL 0' HUP INT TERM QUIT
trap ':' PIPE
(
  trap '' HUP INT TERM QUIT
  IFS= read -r hold <&4
  kill -KILL 0
) &
exec 4<&- 6<&0
"$@" <&6 3>&- 4<&- 6<&- &
installer=$!
exec 6<&-
wait "$installer"
result=$?
printf '%s\\n' "$result" >&3
kill -KILL 0
`;

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
  let childExited = false;
  let cleanupRequested = false;
  let interrupted: NodeJS.Signals | undefined;
  const terminate = (signal: NodeJS.Signals = "SIGKILL") => {
    if (!child) return;
    // ChildProcess.kill targets only this unreaped child and refuses an exited
    // handle. The supervisor's interrupted wait kills its own group, providing
    // Stop cleanup even if the watcher was lost. Never signal a numeric PGID.
    if (!childExited && child.pid) child.kill(process.platform === "win32" ? signal : "SIGTERM");
    if (process.platform !== "win32" && !cleanupRequested && child.stdio[4]) {
      cleanupRequested = true;
      child.stdio[4].destroy();
    }
  };
  const stop = (signal: NodeJS.Signals) => {
    interrupted ??= signal;
    abort.abort();
    terminate(signal);
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
      const posix = process.platform !== "win32";
      child = spawn(
        posix ? "/bin/sh" : `/bin/${script.interpreter}`,
        posix
          ? [
              "-c",
              installerSupervisor,
              "foom-installer",
              `/bin/${script.interpreter}`,
              path,
              ...script.arguments,
            ]
          : [path, ...script.arguments],
        {
          cwd: home,
          env,
          shell: false,
          stdio: posix ? ["inherit", "inherit", "inherit", "pipe", "pipe"] : "inherit",
          detached: posix,
        },
      );
      let failed = false;
      let reported: number | undefined;
      let report = "";
      child.stdio[3]?.on("data", (bytes: Buffer) => {
        report += bytes.toString("ascii");
        // Only the supervisor writes this fd; the watcher holds it until cleanup.
        // The interpreter and its descendants inherit neither private pipe.
        if (report.length > 4 || !/^\d{1,3}\n$/.test(report)) {
          if (report.length > 4 || report.includes("\n")) terminate("SIGKILL");
          return;
        }
        const code = Number(report.trim());
        if (code <= 255) reported = code;
        terminate("SIGKILL");
      });
      child.once("error", () => {
        failed = true;
      });
      // close can wait for the watcher's inherited fd3. exit must release fd4
      // immediately when the supervisor dies, even while the interpreter runs.
      child.once("exit", () => {
        childExited = true;
        terminate();
      });
      child.once("close", (code, signal: NodeJS.Signals | null) => {
        childExited = true;
        resolve(
          interrupted
            ? status()
            : failed
              ? 1
              : posix
                ? (reported ?? 1)
                : (code ?? (signal ? 128 + constants.signals[signal] : 1)),
        );
      });
    });
  } catch {
    if (!interrupted) process.stderr.write("Installer download or execution failed\n");
  } finally {
    try {
      // Closing the lifetime pipe is safe even after the supervisor has been reaped.
      terminate("SIGKILL");
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        for (const { signal, handler } of handlers) process.removeListener(signal, handler);
      }
    }
  }
  return interrupted ? status() : outcome;
}
