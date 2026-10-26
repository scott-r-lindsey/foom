import { remotePath } from "../../shared/remote-agent-protocol";
import { ApplicationError } from "../../shared/application-errors";
import type { RemoteTarget } from "../../shared/remote-host";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import { remoteHost } from "../../shared/remote-host-protocol";

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
export async function hostArtifact(path: string, expectedSource?: string) {
  if (!isAbsolute(path)) throw new Error("Host artifact must be absolute");
  const stored = await boundedFile(path, 200 * 1024 * 1024);
  const compressed = path.endsWith(".gz");
  const bytes = compressed
    ? await promisify(gunzip)(stored, { maxOutputLength: 200 * 1024 * 1024 })
    : stored;
  const value: unknown = JSON.parse(
    (await boundedFile(join(dirname(path), "manifest.json"), 4096)).toString("utf8"),
  );
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
    value.protocol !== 2 ||
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
umask 077
# Recheck on every connection before touching the cache or accepting an upload.
test "$(uname -s)" = '${platform === "linux" ? "Linux" : "Darwin"}'
test "$(uname -m)" = '${arch === "x64" ? "x86_64" : platform === "linux" ? "aarch64" : "arm64"}'
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
      throw new Error("Unsupported remote host platform");
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
) {
  let expectedSource: string | undefined;
  if (!target.artifact) {
    const value: unknown = JSON.parse((await boundedFile(metadata, 4096)).toString("utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("source" in value) ||
      typeof value.source !== "string" ||
      !/^[a-f0-9]{40}$/u.test(value.source)
    )
      throw new Error("Invalid application source revision");
    if ("remoteHostsAvailable" in value && value.remoteHostsAvailable === false)
      throw new ApplicationError("remote-host-unavailable");
    expectedSource = value.source;
  }
  const { stdout } = await promisify(execFile)(
    "ssh",
    [...sshArguments(target.host), "uname -s; uname -m"],
    { env: sshEnvironment(), shell: false, timeout: 10000, maxBuffer: 256, encoding: "utf8" },
  );
  const remote = remotePlatform(stdout);
  const artifact = await hostArtifact(
    target.artifact ?? join(catalog, `${remote.platform}-${remote.arch}`, "foom-host.gz"),
    expectedSource,
  );
  if (
    artifact.version !== expectedVersion ||
    artifact.platform !== remote.platform ||
    artifact.arch !== remote.arch
  )
    throw new Error("Host application version or platform mismatch");
  return artifact;
}

/** Explicit one-checkout developer mapping; no renderer/control host selection. */
export function remoteAgentTarget(
  argv: readonly string[],
  checkout: string,
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
  if (checkout !== local) return undefined;
  return { target: { host, artifact }, repository, worktree };
}
