import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReadinessReport, ForgeReadiness } from "../../shared/readiness";
import { loginPath } from "../agents/agents";
import { resolveForgeExecutable } from "../control/forge-process";
import { forgeRemote } from "../control/forge-mapping";

const execute = promisify(execFile);

/** Only registered repositories enter this local read. No renderer paths or CLI diagnostics escape. */
export async function checkReadiness(
  repositories: readonly string[],
  forgeStatus: (host: string) => Promise<ForgeReadiness>,
): Promise<ReadinessReport> {
  const report: ReadinessReport = {
    git: "unavailable",
    platform:
      process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    forges: [],
  };
  const { path } = await loginPath();
  let executable: string;
  try {
    executable = (await resolveForgeExecutable(["git"], path)).executable;
  } catch {
    return { ...report, git: "not-installed" };
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  const options = {
    env: { ...env, PATH: path, GIT_TERMINAL_PROMPT: "0" },
    timeout: 5000,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
    windowsHide: true,
  } as const;
  try {
    const { stdout } = await execute(executable, ["--version"], options);
    if (!/^git version \d+\.\d+(?:\.\d+)?(?:[ .-][A-Za-z0-9.()+_-]+)*\s*$/u.test(stdout))
      return { ...report, git: "invalid-version" };
  } catch {
    return report;
  }
  const hosts = new Set<string>();
  for (const cwd of repositories) {
    try {
      const { stdout } = await execute(
        executable,
        ["config", "--local", "--get-regexp", "^remote\\..*\\.url$"],
        { ...options, cwd },
      );
      for (const line of stdout.split(/\r?\n/u)) {
        const url = line.slice(line.indexOf(" ") + 1);
        const remote = forgeRemote(url, "nested");
        if (remote && hosts.size < 1000) hosts.add(remote.host);
      }
    } catch {
      // No remotes (exit 1), removed checkout or unreadable config grants no probe authority.
    }
  }
  const forges: { host: string; status: ForgeReadiness }[] = [];
  for (const host of [...hosts].sort())
    forges.push({ host, status: await forgeStatus(host).catch(() => "unavailable" as const) });
  return { ...report, git: "ready", forges };
}
