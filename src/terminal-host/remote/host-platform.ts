import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { HostPlatform } from "./host-platform.d";
import { linuxHostPlatform } from "./host-platform-linux";
import { hostProbe } from "./agent-discovery";

/** Exact cached executable and argv, not a process name supplied by a peer. */
async function darwinProcessIdentity(
  executable: string,
  signal?: AbortSignal,
): Promise<{ pid: number; started: string } | undefined> {
  const result = await promisify(execFile)(
    "/bin/ps",
    ["-ww", "-u", String(process.getuid?.() ?? -1), "-o", "pid=,lstart=,args="],
    {
      ...(signal ? { signal } : {}),
      encoding: "utf8",
      shell: false,
      timeout: 5000,
      maxBuffer: 256 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    },
  );
  const matches = result.stdout.split("\n").flatMap((line) => {
    const match =
      /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u.exec(
        line,
      );
    if (!match || match[3] !== `${executable} --daemon`) return [];
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid > 1 && match[2] ? [{ pid, started: match[2] }] : [];
  });
  if (matches.length > 1) throw new Error("Legacy daemon identity unavailable");
  return matches[0];
}
/** Select only from the daemon's OS, never a peer's input. */
export function createHostPlatform(platform: string, home = homedir()): HostPlatform {
  if (platform === "linux") return linuxHostPlatform();
  if (platform !== "darwin")
    return {
      memoryAvailable() {
        return Promise.reject(new Error("Memory unavailable"));
      },
      processIdentity() {
        return Promise.reject(new Error("Legacy daemon identity unavailable"));
      },
    };
  return {
    processIdentity: darwinProcessIdentity,
    async memoryAvailable(signal) {
      const text = await hostProbe("/usr/bin/vm_stat", [], home, undefined, false, 5000, signal);
      const page = /page size of (\d+) bytes/u.exec(text)?.[1];
      if (!page) throw new Error("Memory unavailable");
      let count = 0;
      for (const name of ["free", "inactive", "speculative"]) {
        const match = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, "mu").exec(text)?.[1];
        if (!match) throw new Error("Memory unavailable");
        count += Number(match);
      }
      return count * Number(page);
    },
  };
}

/** Module initialization happens once when the daemon starts. */
export const daemonHostPlatform = createHostPlatform(process.platform);
