import { remotePath } from "../../shared/remote-agent-protocol";
import type { RemoteTarget } from "../../shared/remote-host";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
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
export async function hostArtifact(path: string) {
  if (!isAbsolute(path)) throw new Error("Host artifact must be absolute");
  const bytes = await boundedFile(path, 200 * 1024 * 1024);
  const value: unknown = JSON.parse(
    (await boundedFile(join(dirname(path), "manifest.json"), 4096)).toString("utf8"),
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(value.version) ||
    !("sha256" in value) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    !("protocol" in value) ||
    value.protocol !== 2 ||
    !("size" in value) ||
    value.size !== bytes.length ||
    !("platform" in value) ||
    !["linux", "darwin"].includes(String(value.platform)) ||
    !("arch" in value) ||
    !["x64", "arm64"].includes(String(value.arch)) ||
    createHash("sha256").update(bytes).digest("hex") !== value.sha256
  )
    throw new Error("Host artifact manifest mismatch");
  return { bytes, version: value.version, sha256: value.sha256 };
}
export function bootstrapArguments(
  host: string,
  version: string,
  sha256: string,
  size: number,
): string[] {
  if (
    !remoteHost(host) ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(version) ||
    !/^[a-f0-9]{64}$/u.test(sha256) ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 200 * 1024 * 1024
  )
    throw new Error("Invalid SSH bootstrap");
  // OpenSSH joins remote argv with spaces and runs the account's shell. Only
  // fixed code and narrowly validated version/hash/size literals enter this script.
  // stdin remains the same SSH channel for the artifact and the framed protocol.
  const script = `set -eu
umask 077
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
  head -c ${String(size)} > "$t"
  test "$(wc -c < "$t" | tr -d ' ')" = '${String(size)}'
  test "$(hash "$t" | cut -d ' ' -f 1)" = '${sha256}'
  chmod 700 "$t"
  mv -f "$t" "$f"
  trap - EXIT HUP INT TERM
  printf 'FOOM-READY\\n'
fi
exec "$f" --connect`;
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
    "sh",
    "-c",
    `'${script.replaceAll("'", "'\\''")}'`,
  ];
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
    artifacts.length !== 1 ||
    !remoteHost(host) ||
    !artifact ||
    !isAbsolute(artifact)
  )
    throw new Error("Invalid remote shell spike arguments");
  return { host, artifact };
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
