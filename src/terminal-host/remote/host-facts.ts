import { constants } from "node:fs";
import { open, access, stat } from "node:fs/promises";
import { posix } from "node:path";
import type { HostRequirements, HostSignIn } from "../../shared/registered-hosts.d";
import { hostProbe, HostProbeExit } from "./agent-discovery";

/** os-release is data, never shell source. Reject expansion, escapes and duplicate keys. */
export function hostDistro(source: string): HostRequirements["distro"] {
  if (source.length > 65536 || source.includes("\0") || source.includes("\r")) return "unknown";
  const fields = new Map<string, string>();
  for (const line of source.split("\n")) {
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(?:"([^"\\$`]*?)"|'([^'\\$`]*?)'|([A-Za-z0-9._-]*))$/u.exec(
      line,
    );
    if (!match || !match[1] || fields.has(match[1])) return "unknown";
    fields.set(match[1], match[2] ?? match[3] ?? match[4] ?? "");
  }
  const family = (id: string) => {
    if (["debian", "ubuntu"].includes(id)) return "debian";
    if (["rhel", "centos", "rocky", "almalinux", "fedora", "amzn"].includes(id)) return "rhel";
    if (id === "arch") return "arch";
    return undefined;
  };
  return (
    family(fields.get("ID") ?? "") ??
    fields
      .get("ID_LIKE")
      ?.split(" ")
      .map(family)
      .find((value) => value !== undefined) ??
    "unknown"
  );
}
export function hostLibc(source: string): HostRequirements["libc"] {
  const match = /^glibc (\d{1,4})\.(\d{1,4})\n?$/u.exec(source);
  if (!match) return "unsupported";
  return Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 28)
    ? "supported"
    : "too-old";
}
export function macSleep(source: string): boolean {
  // Every power-source section must disable idle sleep. Unknown output warns.
  const values = [...source.matchAll(/^[ \t]*sleep[ \t]+(\d+)(?:[ \t].*)?$/gmu)];
  return values.length > 0 && values.every((value) => value[1] === "0");
}
export function protectedCodeFolder(folder: string, home: string): boolean {
  return ["Documents", "Desktop", "Downloads"].some(
    (name) => folder === posix.join(home, name) || folder.startsWith(`${posix.join(home, name)}/`),
  );
}
async function osRelease(): Promise<string> {
  const file = await open(
    "/etc/os-release",
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY,
  );
  try {
    if (!(await file.stat()).isFile()) return "";
    const bytes = Buffer.alloc(65537);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > 65536) return "";
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
  } finally {
    await file.close();
  }
}
export async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
/** No credential files or Keychain APIs. Output is drained and discarded, never decoded. */
export async function signInStatus(
  command: string,
  args: readonly string[],
  home: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<HostSignIn> {
  try {
    await hostProbe(command, args, home, env, false, 5000, signal, "status");
    return "signed-in";
  } catch (error) {
    return error instanceof HostProbeExit && error.code === 1 ? "signed-out" : "unknown";
  }
}
export async function requirements(
  platform: string,
  folder: string,
  home: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<HostRequirements> {
  const probe = (command: string, args: string[]) =>
    hostProbe(command, args, home, { ...env, LANG: "C", LC_ALL: "C" }, false, 5000, signal).catch(
      () => "",
    );
  let distro: HostRequirements["distro"] = "unknown";
  let libc: HostRequirements["libc"] = "unsupported";
  let packageManager: HostRequirements["packageManager"] = "none";
  if (platform === "linux") {
    distro = hostDistro(await osRelease().catch(() => ""));
    libc = hostLibc(await probe("/usr/bin/getconf", ["GNU_LIBC_VERSION"]));
    const path =
      distro === "debian"
        ? "/usr/bin/apt-get"
        : distro === "rhel"
          ? "/usr/bin/dnf"
          : "/usr/bin/pacman";
    if (distro !== "unknown" && (await executable(path)))
      packageManager = distro === "debian" ? "apt" : distro === "rhel" ? "dnf" : "pacman";
  }
  let mac: HostRequirements["mac"];
  if (platform === "darwin") {
    distro = "darwin";
    libc = "supported";
    // Neither fallback paths nor a non-login PATH may discover Homebrew.
    for (const directory of (env["PATH"] ?? "").split(":")) {
      if (
        ["/opt/homebrew/bin", "/usr/local/bin"].includes(directory) &&
        (await executable(posix.join(directory, "brew")))
      )
        packageManager = "brew";
    }
    mac = {
      commandLineTools: (await probe("/usr/bin/xcode-select", ["-p"])).startsWith("/"),
      staysAwake: macSleep(await probe("/usr/bin/pmset", ["-g"])),
      protectedFolder: protectedCodeFolder(folder, home),
    };
  }
  signal?.throwIfAborted();
  return { distro, libc, packageManager, ...(mac ? { mac } : {}) };
}
