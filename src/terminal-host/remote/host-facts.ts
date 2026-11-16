import { constants } from "node:fs";
import { open, access, stat } from "node:fs/promises";
import { posix } from "node:path";
import type { HostRequirements, HostSignIn } from "../../shared/registered-hosts.d";
import { hostProbe, HostProbeExit } from "./agent-discovery";

import { hostDistro, hostLibc } from "../../shared/host-system";
export { hostDistro, hostLibc } from "../../shared/host-system";
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
  scope?: string,
): Promise<HostRequirements> {
  const probe = (command: string, args: string[]) =>
    hostProbe(command, args, home, { ...env, LANG: "C", LC_ALL: "C" }, false, 5000, signal).catch(
      () => "",
    );
  let distro: HostRequirements["distro"] = "unknown";
  let libc: HostRequirements["libc"] = "unsupported";
  let packageManager: HostRequirements["packageManager"] = "none";
  if (platform === "linux" && (!scope || scope === "platform")) {
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
    for (const directory of !scope ? (env["PATH"] ?? "").split(":") : []) {
      if (
        ["/opt/homebrew/bin", "/usr/local/bin"].includes(directory) &&
        (await executable(posix.join(directory, "brew")))
      )
        packageManager = "brew";
    }
    mac = {
      commandLineTools:
        (!scope || scope === "command-line-tools") &&
        (await probe("/usr/bin/xcode-select", ["-p"])).startsWith("/"),
      staysAwake: (!scope || scope === "power") && macSleep(await probe("/usr/bin/pmset", ["-g"])),
      protectedFolder: protectedCodeFolder(folder, home),
    };
  }
  signal?.throwIfAborted();
  return { distro, libc, packageManager, ...(mac ? { mac } : {}) };
}
