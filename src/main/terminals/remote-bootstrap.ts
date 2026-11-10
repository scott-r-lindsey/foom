import { sshFailure } from "../../node-common/ssh-askpass";
import { LaunchFailure } from "../../shared/launch-failure";
import { remotePath } from "../../shared/remote-agent-protocol";
import { ApplicationError } from "../../shared/application-errors";
import type { HostCheck, HostConnectionChecks } from "../../shared/registered-hosts.d";
import type { RemoteTarget } from "../../shared/remote-host";
import { constants, fstatSync, readSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import { remoteHost } from "../../shared/remote-host-protocol";

export const LINUX_LIBC_CHECK = `if ! libc=$(/usr/bin/getconf GNU_LIBC_VERSION 2>/dev/null); then
  printf 'FOOM-LIBC-UNSUPPORTED\\n'; exit 1
fi
case "$libc" in
  'glibc '*) version=\${libc#glibc }; major=\${version%%.*}; minor=\${version#*.};;
  *) printf 'FOOM-LIBC-UNSUPPORTED\\n'; exit 1;;
esac
case "$version" in *.*) ;; *) printf 'FOOM-LIBC-UNSUPPORTED\\n'; exit 1;; esac
case "$minor" in *.*) printf 'FOOM-LIBC-UNSUPPORTED\\n'; exit 1;; esac
case "$major.$minor" in *[!0-9.]*|.*|*.) printf 'FOOM-LIBC-UNSUPPORTED\\n'; exit 1;; esac
if ! { test "$major" -gt 2 || { test "$major" -eq 2 && test "$minor" -ge 28; }; } 2>/dev/null; then
  printf 'FOOM-LIBC-TOO-OLD\\n'; exit 1
fi`;

async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY,
  );
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit)
      throw new Error("Invalid host artifact");
    const bytes = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await fd.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== info.size) throw new Error("Host artifact changed");
    return bytes.subarray(0, used);
  } finally {
    await fd.close();
  }
}
// Retain one content-addressed verification, including concurrent readers. Each
// caller still opens bounded, non-symlink files and hashes their current bytes;
// neither a path nor file timestamps establish trust. Sharing the verified buffers
// avoids expanding a full Node SEA for every short-lived management connection.
let verifiedArtifact: { key: string; value: ReturnType<typeof verifyArtifact> } | undefined;

export async function hostArtifact(path: string, expectedSource?: string) {
  if (!isAbsolute(path)) throw new Error("Host artifact must be absolute");
  const stored = await boundedFile(path, 200 * 1024 * 1024);
  const compressed = path.endsWith(".gz");
  const manifest = await boundedFile(join(dirname(path), "manifest.json"), 4096);
  const key = createHash("sha256")
    .update(stored)
    .update(manifest)
    .update(JSON.stringify([stored.length, manifest.length, compressed, expectedSource]))
    .digest("hex");
  if (verifiedArtifact?.key === key) return verifiedArtifact.value;
  const value = verifyArtifact(stored, compressed, manifest, expectedSource).catch(
    (error: unknown) => {
      if (verifiedArtifact?.key === key) verifiedArtifact = undefined;
      throw error;
    },
  );
  verifiedArtifact = { key, value };
  return value;
}

async function verifyArtifact(
  stored: Buffer,
  compressed: boolean,
  manifest: Buffer,
  expectedSource?: string,
) {
  const bytes = compressed
    ? await promisify(gunzip)(stored, { maxOutputLength: 200 * 1024 * 1024 })
    : stored;
  const value: unknown = JSON.parse(manifest.toString("utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u.test(value.version) ||
    !("source" in value) ||
    typeof value.source !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.source) ||
    (expectedSource !== undefined && value.source !== expectedSource) ||
    !("sha256" in value) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !("protocol" in value) ||
    value.protocol !== 3 ||
    !("size" in value) ||
    value.size !== bytes.length ||
    bytes.length === 0 ||
    !("platform" in value) ||
    (value.platform !== "linux" && value.platform !== "darwin") ||
    !("arch" in value) ||
    (value.arch !== "x64" && value.arch !== "arm64") ||
    createHash("sha256").update(bytes).digest("hex") !== value.sha256 ||
    (compressed &&
      (!("gzipSize" in value) ||
        value.gzipSize !== stored.length ||
        !("gzipSha256" in value) ||
        value.gzipSha256 !== createHash("sha256").update(stored).digest("hex")))
  )
    throw new Error("Host artifact manifest mismatch");
  return {
    bytes,
    upload: compressed ? stored : await promisify(gzip)(bytes, { level: 1 }),
    version: value.version,
    sha256: value.sha256,
    platform: value.platform,
    arch: value.arch,
  };
}
export function bootstrapArguments(
  host: string,
  version: string,
  sha256: string,
  size: number,
  uploadSize: number,
  platform: string,
  arch: string,
): string[] {
  if (
    !remoteHost(host) ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u.test(version) ||
    !/^[a-f0-9]{64}$/u.test(sha256) ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 200 * 1024 * 1024 ||
    !Number.isSafeInteger(uploadSize) ||
    uploadSize < 1 ||
    uploadSize > 200 * 1024 * 1024 ||
    !["linux", "darwin"].includes(platform) ||
    !["x64", "arm64"].includes(arch)
  )
    throw new Error("Invalid SSH bootstrap");
  // OpenSSH joins remote argv with spaces and runs the account's shell. Only
  // fixed code and narrowly validated version/hash/size literals enter this script.
  // stdin remains the same SSH channel for the artifact and the framed protocol.
  const script = `set -eu
login_umask=$(umask)
umask 077
# Recheck on every connection before touching the cache or accepting an upload.
test "$(uname -s)" = '${platform === "linux" ? "Linux" : "Darwin"}'
test "$(uname -m)" = '${arch === "x64" ? "x86_64" : platform === "linux" ? "aarch64" : "arm64"}'
${platform === "linux" ? LINUX_LIBC_CHECK : ""}
case "$HOME" in /*) ;; *) exit 1;; esac
test ! -L "$HOME" && test -d "$HOME" && test -O "$HOME"
test "$(CDPATH= cd -- "$HOME" && pwd -P)" = "$HOME"
test "$(LC_ALL=C ls -ld "$HOME" | cut -c6,9)" = '--'
safe_dir() {
  test ! -L "$1" || exit 1
  if test ! -e "$1"; then mkdir -m 700 "$1"; fi
  test -d "$1" && test -O "$1" || exit 1
  case "$(LC_ALL=C ls -ld "$1")" in drwx------*) ;; *) exit 1;; esac
}
safe_dir "$HOME/.foom-host"
safe_dir "$HOME/.foom-host/${version}"
safe_dir "$HOME/.foom-host/${version}/${sha256}"
d="$HOME/.foom-host/${version}/${sha256}"
f="$d/foom-host"
hash() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi; }
test ! -L "$f" || exit 1
if test -f "$f" && test -O "$f" && test "$(hash "$f" | cut -d ' ' -f 1)" = '${sha256}'; then
  printf 'FOOM-READY\\n'
else
  printf 'FOOM-UPLOAD\\n'
  t=$(mktemp "$d/upload.XXXXXXXX")
  trap 'rm -f "$t"' EXIT HUP INT TERM
  z=$(mktemp "$d/upload-gzip.XXXXXXXX")
  trap 'rm -f "$t" "$z"' EXIT HUP INT TERM
  head -c ${String(uploadSize)} > "$z"
  test "$(wc -c < "$z" | tr -d ' ')" = '${String(uploadSize)}'
  gzip -dc "$z" > "$t"
  rm -f "$z"
  test "$(wc -c < "$t" | tr -d ' ')" = '${String(size)}'
  test "$(hash "$t" | cut -d ' ' -f 1)" = '${sha256}'
  chmod 700 "$t"
  mv -f "$t" "$f"
  trap - EXIT HUP INT TERM
  printf 'FOOM-READY\\n'
fi
umask "$login_umask"
exec "$f" --connect`;
  return [...sshArguments(host), "sh", "-c", `'${script.replaceAll("'", "'\\''")}'`];
}

/** Explicit main-process argv only; never accepted from IPC or saved settings. */
export function remoteSpikeTarget(argv: readonly string[]): RemoteTarget | undefined {
  const hosts = argv.filter((arg) => arg.startsWith("--remote-shell-spike="));
  const artifacts = argv.filter((arg) => arg.startsWith("--remote-host-artifact="));
  if (!hosts.length && !artifacts.length) return undefined;
  const host = hosts[0]?.slice("--remote-shell-spike=".length);
  const artifact = artifacts[0]?.slice("--remote-host-artifact=".length);
  if (
    hosts.length !== 1 ||
    artifacts.length > 1 ||
    !remoteHost(host) ||
    (artifact !== undefined && !isAbsolute(artifact))
  )
    throw new Error("Invalid remote shell spike arguments");
  return { host, ...(artifact ? { artifact } : {}) };
}

export function sshArguments(host: string): string[] {
  if (!remoteHost(host)) throw new Error("Invalid SSH host");
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ConnectTimeout=10",
    "--",
    host,
  ];
}

export function sshEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "USERPROFILE",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "SSH_AUTH_SOCK",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export class UnsupportedRemotePlatform extends Error {}
export class InvalidRemoteProbe extends Error {}
/** A main-owned OpenSSH diagnostic, including checks without checklist observers. */
export class SshConnectionFailure extends LaunchFailure {
  constructor(readonly failure: ReturnType<typeof sshFailure>) {
    super("remote_host_unreachable");
  }
}

// The fixed prelude reads a bounded, hub-generated bootstrap command, then leaves
// stdin to the existing upload/framed protocol. No checkout code is evaluated.
const CHECK_PRELUDE = `uname -s; uname -m
if test "$(uname -s)" = Linux; then
  (${LINUX_LIBC_CHECK}) && printf 'FOOM-LIBC-OK\\n'
else printf 'FOOM-LIBC-OK\\n'; fi
printf 'FOOM-PROBED\\n'
IFS= read -r size || exit 1
case "$size" in ''|*[!0-9]*) exit 1;; esac
test "$size" -le 65536 && test "$size" -gt 0 || exit 1
script=$(head -c "$size") || exit 1
exec sh -c "$script"`;

async function platformProbe(
  host: string,
  signal?: AbortSignal,
  output?: (text: string) => void,
  retain?: (child: ChildProcessWithoutNullStreams) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), "foom-ssh-probe-"));
  const diagnostic = join(directory, "ssh.log");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const lifetime = { retained: false };
  const dispose = async () => {
    try {
      await handle?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    handle = await open(diagnostic, "wx+", 0o600);
    const fd = handle.fd;
    const detached = process.platform !== "win32";
    const systemRoot = process.env["SystemRoot"] ?? "";
    if (!detached && (!systemRoot || !isAbsolute(systemRoot)))
      throw new SshConnectionFailure("unreachable");
    if (signal?.aborted) throw new SshConnectionFailure("unreachable");
    return await new Promise<{ stdout: string; libc?: string }>((resolve, reject) => {
      // -E keeps client diagnostics separate from remote stderr. execFile does
      // not forward detached, so use spawn for an owned POSIX process group.
      const child = spawn(
        "ssh",
        [
          "-E",
          diagnostic,
          "-o",
          "LogLevel=ERROR",
          "-o",
          "StrictHostKeyChecking=yes",
          ...(retain
            ? ["-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no"]
            : []),
          ...sshArguments(host),
          ...(retain
            ? ["sh", "-c", `'${CHECK_PRELUDE.replaceAll("'", "'\\''")}'`]
            : ["uname -s; uname -m"]),
        ],
        {
          env: { ...sshEnvironment(), LC_ALL: "C" },
          shell: false,
          detached,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let failed = false;
      let invalid = false;
      let stopped = false;
      let cleanup: Promise<void> | undefined;
      const stdout: string[] = [];
      const sizes = { stdout: 0, stderr: 0 };
      const stop = () => {
        if (stopped) return;
        stopped = true;
        const pid = child.pid;
        if (!detached && pid !== undefined) {
          cleanup = new Promise<void>((done) => {
            execFile(
              join(systemRoot, "System32", "taskkill.exe"),
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
            if (pid !== undefined) process.kill(-pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            // The owned process group may already have exited.
          }
        }
      };
      const fail = () => {
        failed = true;
        stop();
      };
      // Drain the retained client's channel before the transport observes its exit.
      let diagnosticOffset = 0;
      const check = () => {
        try {
          const size = fstatSync(fd).size;
          if (size > 16384) fail();
          else if (lifetime.retained && !failed && output && size > diagnosticOffset) {
            const bytes = Buffer.alloc(size - diagnosticOffset);
            const count = readSync(fd, bytes, 0, bytes.length, diagnosticOffset);
            diagnosticOffset += count;
            output(bytes.subarray(0, count).toString("utf8"));
          }
        } catch {
          fail();
        }
      };
      // Monitor even successful probes. A final synchronous check catches a
      // short-lived writer before the first tick; failures can never offer trust.
      const monitor = setInterval(check, 10);
      const deadline = setTimeout(fail, 10000);
      signal?.addEventListener("abort", fail, { once: true });
      const collect = (stream: "stdout" | "stderr", data: string) => {
        sizes[stream] += Buffer.byteLength(data);
        if (sizes[stream] > 16384) fail();
        else {
          if (stream === "stdout") stdout.push(data);
          if (!retain || stream === "stderr") output?.(data);
          if (retain && stream === "stdout" && stdout.join("").endsWith("FOOM-PROBED\n")) {
            check();
            if (failed) return;
            const lines = stdout.join("").split("\n");
            if (lines.length !== 5 || lines[3] !== "FOOM-PROBED") {
              invalid = true;
              fail();
              return;
            }
            output?.(`${lines[0] ?? ""}\n${lines[1] ?? ""}\n`);
            lifetime.retained = true;
            clearTimeout(deadline);
            child.stdout.removeAllListeners("data");
            child.stderr.removeAllListeners("data");
            retain(child);
            resolve({ stdout: `${lines[0] ?? ""}\n${lines[1] ?? ""}\n`, libc: lines[2] ?? "" });
          }
        }
      };
      child.stdout.on("data", (data: Buffer) => {
        collect("stdout", data.toString("utf8"));
      });
      child.stderr.on("data", (data: Buffer) => {
        collect("stderr", data.toString("utf8"));
      });
      child.on("error", fail);
      child.on("exit", () => {
        check();
        if (detached) stop();
      });
      child.on("close", (code) => {
        check();
        clearInterval(monitor);
        clearTimeout(deadline);
        signal?.removeEventListener("abort", fail);
        void (async () => {
          await cleanup;
          const text =
            failed || lifetime.retained
              ? undefined
              : await boundedFile(diagnostic, 16384).catch(() => undefined);
          if (lifetime.retained) {
            await dispose();
            return;
          }
          if (invalid || (retain && !failed && code === 0)) {
            reject(new InvalidRemoteProbe("Invalid check prelude"));
          } else if (failed || code !== 0) {
            if (text) output?.(text.toString("utf8"));
            reject(
              new SshConnectionFailure(
                sshFailure(!failed && code === 255 ? text?.toString("utf8") : undefined),
              ),
            );
          } else resolve({ stdout: stdout.join("") });
        })();
      });
      if (signal?.aborted) fail();
    });
  } finally {
    if (!lifetime.retained) await dispose();
  }
}

/** Strict uname output mapping; remote text is never used as a path or shell code. */
export function remotePlatform(output: string) {
  switch (output) {
    case "Linux\nx86_64\n":
      return { platform: "linux", arch: "x64" };
    case "Linux\naarch64\n":
      return { platform: "linux", arch: "arm64" };
    case "Darwin\nx86_64\n":
      return { platform: "darwin", arch: "x64" };
    case "Darwin\narm64\n":
      return { platform: "darwin", arch: "arm64" };
    default:
      throw new UnsupportedRemotePlatform("Unsupported remote host platform");
  }
}

export async function selectHostArtifact(
  target: RemoteTarget,
  expectedVersion: string,
  catalog = join(
    __dirname.replace(/app\.asar(?=[/\\])/u, "app.asar.unpacked"),
    "../../remote-hosts",
  ),
  metadata = join(__dirname, "../../build-metadata.json"),
  signal?: AbortSignal,
  observe?: (stage: keyof HostConnectionChecks, result: HostCheck) => void,
  output?: (text: string, startLine?: boolean) => void,
  retain?: (child: ChildProcessWithoutNullStreams) => void,
) {
  let missingArtifact = false;
  let expectedSource: string | undefined;
  if (!target.artifact) {
    try {
      const value: unknown = JSON.parse((await boundedFile(metadata, 4096)).toString("utf8"));
      if (
        typeof value !== "object" ||
        value === null ||
        !("source" in value) ||
        typeof value.source !== "string" ||
        !/^[a-f0-9]{40}$/u.test(value.source)
      )
        throw new ApplicationError("remote-host-unavailable");
      if (!("remoteHostsAvailable" in value) || value.remoteHostsAvailable !== true)
        throw new ApplicationError("remote-host-unavailable");
      expectedSource = value.source;
    } catch {
      if (!observe) throw new ApplicationError("remote-host-unavailable");
      missingArtifact = true;
    }
  }
  output?.("Connecting…\nPlatform\n", true);
  const { stdout, libc: combinedLibc } = await platformProbe(
    target.host,
    signal,
    output,
    retain,
  ).catch((error: unknown) => {
    if (error instanceof InvalidRemoteProbe) {
      observe?.("ssh", { state: "pass" });
      throw error;
    }
    const failure = error instanceof SshConnectionFailure ? error.failure : "unreachable";
    observe?.("ssh", { state: "fail", reason: failure });
    throw new SshConnectionFailure(failure);
  });
  observe?.("ssh", { state: "pass" });
  let remote: ReturnType<typeof remotePlatform>;
  try {
    remote = remotePlatform(stdout);
  } catch (error) {
    observe?.("platform", { state: "fail", reason: "unsupported" });
    throw error;
  }
  if (observe && remote.platform === "linux") {
    const libc = retain
      ? combinedLibc === "FOOM-LIBC-OK"
        ? undefined
        : combinedLibc === "FOOM-LIBC-TOO-OLD"
          ? "libc-too-old"
          : combinedLibc === "FOOM-LIBC-UNSUPPORTED"
            ? "libc-unsupported"
            : "unreachable"
      : await promisify(execFile)(
          "ssh",
          [
            ...sshArguments(target.host),
            "sh",
            "-c",
            `'${LINUX_LIBC_CHECK.replaceAll("'", "'\\''")}'`,
          ],
          {
            env: sshEnvironment(),
            shell: false,
            timeout: 10000,
            maxBuffer: 256,
            encoding: "utf8",
            ...(signal ? { signal } : {}),
          },
        )
          .then(() => undefined)
          .catch((error: unknown) => {
            const output =
              error instanceof Error && "stdout" in error && typeof error.stdout === "string"
                ? error.stdout
                : "";
            return output.includes("FOOM-LIBC-TOO-OLD")
              ? ("libc-too-old" as const)
              : output.includes("FOOM-LIBC-UNSUPPORTED")
                ? ("libc-unsupported" as const)
                : ("unreachable" as const);
          });
    if (libc === "unreachable") {
      observe("ssh", { state: "fail", reason: "unreachable" });
      observe("platform", { state: "not-checked" });
      throw new LaunchFailure("remote_host_unreachable");
    }
    observe("platform", libc ? { state: "fail", reason: libc } : { state: "pass" });
    if (libc) throw new UnsupportedRemotePlatform("Unsupported remote host platform");
  } else observe?.("platform", { state: "pass" });
  if (missingArtifact) {
    observe?.("artifact", { state: "fail", reason: "artifact-unavailable" });
    throw new ApplicationError("remote-host-unavailable");
  }
  output?.("Verifying daemon artifact…\n", true);
  const artifact = await hostArtifact(
    target.artifact ?? join(catalog, `${remote.platform}-${remote.arch}`, "foom-host.gz"),
    expectedSource,
  ).catch(() => {
    observe?.("artifact", { state: "fail", reason: "artifact-unavailable" });
    throw new ApplicationError("remote-host-unavailable");
  });
  if (
    artifact.version !== expectedVersion ||
    artifact.platform !== remote.platform ||
    artifact.arch !== remote.arch
  ) {
    observe?.("artifact", { state: "fail", reason: "version-mismatch" });
    throw new LaunchFailure("remote_artifact_mismatch");
  }
  observe?.("artifact", { state: "pass" });
  return artifact;
}

/** Explicit one-checkout developer mapping; no renderer/control host selection. */
export function remoteAgentTarget(
  argv: readonly string[],
  checkout?: string,
): { target: RemoteTarget; repository: string; worktree: string } | undefined {
  const names = [
    "--remote-agent-spike=",
    "--remote-agent-artifact=",
    "--remote-agent-local-checkout=",
    "--remote-agent-repository=",
    "--remote-agent-worktree=",
  ];
  const values = names.map((name) => argv.filter((arg) => arg.startsWith(name)));
  if (values.every((entries) => entries.length === 0)) return undefined;
  if (values.some((entries) => entries.length !== 1))
    throw new Error("Invalid remote agent mapping");
  const [host, artifact, local, repository, worktree] = values.map((entries, index) =>
    entries[0]?.slice(names[index]?.length),
  );
  if (
    !remoteHost(host) ||
    !artifact ||
    !isAbsolute(artifact) ||
    !local ||
    !isAbsolute(local) ||
    !repository ||
    !remotePath(repository) ||
    !worktree ||
    !remotePath(worktree)
  )
    throw new Error("Invalid remote agent mapping");
  if (checkout !== undefined && checkout !== local) return undefined;
  return { target: { host, artifact }, repository, worktree };
}
