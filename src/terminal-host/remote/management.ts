import { cpus, loadavg, totalmem, homedir } from "node:os";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LaunchFailure } from "../../shared/launch-failure";
import { bundledAgentData } from "../../shared/bundled-agent-data";
import { parseAgentManifest } from "../../shared/agent-plugin-parser";
import { HOST_CLONE_TIMEOUT_MS, hostManagement } from "../../shared/registered-hosts";
import type { HostManagement, HostResult, HostFacts } from "../../shared/registered-hosts.d";
import { hostDiscovery, hostProbe, hostLoginEnvironment } from "./agent-discovery";

/** Check every ancestor; never follow symlinks or create beneath a writable parent. */
export async function approvedCodeFolder(input: string, home: string): Promise<string> {
  const path = input.startsWith("~/") ? join(home, input.slice(2)) : input;
  if (resolve(path) !== path || path === "/") throw new Error("unsafe-folder");
  let current = "/";
  for (const part of path.slice(1).split("/")) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST")
        throw new Error("folder-refused", { cause: error });
    }
    const info = await lstat(current);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      ((info.mode & 0o022) !== 0 &&
        !(current !== path && info.uid === 0 && (info.mode & 0o1000) !== 0)) ||
      (current === path && info.uid !== process.getuid?.())
    )
      throw new Error("unsafe-folder");
  }
  if ((await realpath(path)) !== path) throw new Error("unsafe-folder");
  return path;
}
/** Linux MemAvailable includes reclaimable cache; macOS available = free + inactive + speculative pages (vm_stat), excluding wired/compressed pages. */
export async function availableMemory(platform: string, home: string): Promise<number> {
  if (platform === "linux") {
    const text = await readFile("/proc/meminfo", "utf8");
    const match = /^MemAvailable:\s+(\d+) kB$/mu.exec(text);
    if (!match?.[1]) throw new Error("Memory unavailable");
    return Number(match[1]) * 1024;
  }
  const text = await hostProbe("/usr/bin/vm_stat", [], home);
  const page = /page size of (\d+) bytes/u.exec(text)?.[1];
  if (!page) throw new Error("Memory unavailable");
  let count = 0;
  for (const name of ["free", "inactive", "speculative"]) {
    const match = new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, "mu").exec(text)?.[1];
    if (!match) throw new Error("Memory unavailable");
    count += Number(match);
  }
  return count * Number(page);
}
export async function manageHost(
  request: HostManagement,
  sessions: number,
  shell: string,
  version: string,
  home = homedir(),
): Promise<HostResult> {
  if (!hostManagement(request)) return { ok: false, reason: "folder-refused" };
  let folder: string;
  try {
    folder = await approvedCodeFolder(request.codeFolder, home);
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.message === "unsafe-folder"
          ? "unsafe-folder"
          : "folder-refused",
    };
  }
  let facts: HostFacts;
  try {
    const agents: HostFacts["agents"][number][] = [];
    for (const model of (request.operation === "inspect" ? request.agents : []) ??
      bundledAgentData.map((data) => parseAgentManifest(JSON.stringify(data), "bundled").model)) {
      try {
        const found = await hostDiscovery(model, shell, home);
        agents.push({ id: model.id, state: found.version && found.help ? "ready" : "unable" });
      } catch (error) {
        agents.push({
          id: model.id,
          state:
            error instanceof LaunchFailure && error.reason === "remote_agent_unavailable"
              ? "missing"
              : "unable",
        });
      }
    }
    facts = {
      codeFolder: folder,
      version,
      sessions,
      cores: cpus().length,
      load: loadavg(),
      memoryTotal: totalmem(),
      memoryAvailable: Math.min(totalmem(), await availableMemory(process.platform, home)),
      agents,
    };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (request.operation === "inspect") return { ok: true, facts };
  const path = join(folder, request.directory);
  const env = { ...(await hostLoginEnvironment(shell, home)), GIT_TERMINAL_PROMPT: "0" };
  const git = (args: string[], cwd: string) =>
    hostProbe("git", ["--no-optional-locks", ...args], cwd, env, true);
  const checkout = async (directory: string) => {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0 ||
      (await realpath(directory)) !== directory ||
      (await git(["config", "--get", "remote.origin.url"], directory)).trim() !== request.origin ||
      (await git(["rev-parse", "--show-toplevel"], directory)).trim() !== directory
    )
      throw new Error("Invalid checkout");
    // An initialized repository left by an interrupted clone is not a checkout.
    await git(["rev-parse", "--verify", "HEAD^{commit}"], directory);
    return await git(["status", "--porcelain", "-z", "--untracked-files=normal"], directory);
  };
  try {
    // Recheck the approved parent immediately before each filesystem mutation.
    await approvedCodeFolder(folder, home);
    let exists = true;
    try {
      await lstat(path);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      exists = false;
    }
    if (!exists && request.operation === "repository")
      return { ok: true, facts, checkout: { path, state: "absent" } };
    let status: string;
    if (!exists) {
      const temporary = await mkdtemp(join(folder, ".foom-clone-"));
      try {
        await hostProbe(
          "git",
          ["--no-optional-locks", "clone", "--", request.origin, temporary],
          folder,
          env,
          true,
          HOST_CLONE_TIMEOUT_MS,
        );
        status = await checkout(temporary);
        await approvedCodeFolder(folder, home);
        // Do not replace a destination that appeared while cloning.
        try {
          await lstat(path);
          return { ok: false, reason: "checkout-refused" };
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
        }
        await rename(temporary, path);
      } catch {
        return { ok: false, reason: "clone-failed" };
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    } else status = await checkout(path);
    return { ok: true, facts, checkout: { path, state: status ? "changed" : "clean" } };
  } catch {
    return { ok: false, reason: "checkout-refused" };
  }
}
