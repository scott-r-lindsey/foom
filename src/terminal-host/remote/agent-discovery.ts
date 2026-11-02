import { LaunchFailure } from "../../shared/launch-failure";
import { HostGitFailure, gitFailureReason } from "./git-failure";
import { spawn } from "node:child_process";
import { devNull } from "node:os";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export class HostProbeExit extends Error {
  constructor(readonly code: number | null) {
    super("Remote probe failed");
  }
}

/** Remote-only fixed probes. Strip inherited Git/Foom selectors before every subprocess. */
export function hostEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(GIT_|FOOM_|npm_|ELECTRON_|CLAUDECODE$|NODE_OPTIONS$)/iu.test(key),
    ),
  );
}
export async function hostProbe(
  command: string,
  args: readonly string[],
  cwd: string,
  env = hostEnvironment(),
  hostGitConfig = false,
  timeoutMs = 5000,
  signal?: AbortSignal,
  stdoutBudget: "probe" | "review-snapshot" | "status" = "probe",
  networkGit = false,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env:
        command === "git" && !hostGitConfig
          ? { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull }
          : env,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const diagnostics: Buffer[] = [];
    let stdout = 0;
    let stderr = 0;
    let failure: Error | undefined;
    const kill = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already gone. */
        }
      }
    };
    const cancel = () => {
      failure = networkGit ? new HostGitFailure("cancelled") : new Error("Remote probe cancelled");
      kill();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timer = setTimeout(() => {
      failure = networkGit ? new HostGitFailure("timed-out") : new Error("Remote probe timed out");
      kill();
    }, timeoutMs);
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.length;
      // Snapshot inventories use the same bounded output budget as local Git.
      // Discovery and every stderr stream retain their small probe limit.
      if (stdout > (stdoutBudget === "review-snapshot" ? 16 * 1024 * 1024 : 256 * 1024)) {
        failure = new Error("Remote probe output exceeded");
        kill();
      } else if (stdoutBudget !== "status") chunks.push(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.length;
      if (stderr > 256 * 1024) {
        failure = new Error("Remote probe output exceeded");
        kill();
      } else if (networkGit) diagnostics.push(data);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("exit", kill);
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (failure)
        reject(
          networkGit && !(failure instanceof HostGitFailure)
            ? new HostGitFailure("origin-unreachable")
            : failure,
        );
      else if (code !== 0)
        reject(
          networkGit
            ? new HostGitFailure(gitFailureReason(Buffer.concat(diagnostics).toString("utf8")))
            : new HostProbeExit(code),
        );
      else {
        try {
          resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        } catch {
          reject(new Error("Invalid remote probe output"));
        }
      }
    });
  });
}
export async function hostLoginEnvironment(
  shell: string,
  home: string,
  signal?: AbortSignal,
  requireLogin = false,
): Promise<NodeJS.ProcessEnv> {
  const env = hostEnvironment();
  let path = env["PATH"] ?? "";
  try {
    const output = await hostProbe(
      shell,
      ["-ilc", 'printf "\\000FOOM_PATH\\000%s\\000" "$PATH"'],
      home,
      env,
      false,
      5000,
      signal,
    );
    path = output.split("\0FOOM_PATH\0")[1]?.split("\0")[0] || (requireLogin ? "" : path);
  } catch {
    if (requireLogin) path = "";
    /* Inherited remote PATH is the conservative discovery fallback for ordinary discovery. */
  }
  signal?.throwIfAborted();
  return { ...env, PATH: path.split(":").filter(isAbsolute).join(":") };
}
export async function hostDiscovery(
  model: { executables: readonly string[] },
  shell: string,
  home: string,
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
): Promise<{ command: string; env: NodeJS.ProcessEnv; version: string; help: string }> {
  const launchEnv = environment ?? (await hostLoginEnvironment(shell, home, signal));
  const path = launchEnv["PATH"] ?? "";
  let command: string | undefined;
  for (const name of model.executables) {
    for (const directory of path.split(":")) {
      if (!isAbsolute(directory)) continue;
      const candidate = join(directory, name);
      try {
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) {
          command = candidate;
          break;
        }
      } catch {
        /* Missing/nonexecutable candidates are ignored. */
      }
    }
    if (command) break;
  }
  if (!command) throw new LaunchFailure("remote_agent_unavailable");
  const fixed = async (args: string[]) => {
    try {
      return (await hostProbe(command, args, home, launchEnv, false, 5000, signal)).trim();
    } catch {
      return "";
    }
  };
  const version = await fixed(["--version"]);
  const help = await fixed(["--help"]);
  signal?.throwIfAborted();
  return { command, env: launchEnv, version, help };
}
/** Canonical paths and live Git membership are rechecked immediately before PTY creation. */
export async function remoteCheckout(
  repository: string,
  worktree: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  if ((await realpath(repository)) !== repository || (await realpath(worktree)) !== worktree)
    throw new Error("Remote checkout changed");
  const list = await hostProbe(
    "git",
    ["--no-optional-locks", "worktree", "list", "--porcelain", "-z"],
    repository,
    env,
    false,
    5000,
    signal,
  );
  if (
    !list.split("\0\0").some((entry) => {
      const fields = entry.split("\0");
      return (
        fields[0] === `worktree ${worktree}` &&
        !fields.some((field) => /^(bare|locked|prunable)(?: |$)/u.test(field))
      );
    })
  )
    throw new Error("Remote worktree is unavailable");
  const common = async (cwd: string) =>
    resolve(
      cwd,
      (
        await hostProbe(
          "git",
          ["--no-optional-locks", "rev-parse", "--git-common-dir"],
          cwd,
          env,
          false,
          5000,
          signal,
        )
      ).trim(),
    );
  const repositoryCommon = await common(repository);
  if (repositoryCommon !== (await common(worktree))) throw new Error("Foreign remote worktree");
  const gitDirectory = (
    await hostProbe(
      "git",
      ["--no-optional-locks", "rev-parse", "--absolute-git-dir"],
      worktree,
      env,
      false,
      5000,
      signal,
    )
  ).trim();
  if (
    (await realpath(repositoryCommon)) !== repositoryCommon ||
    (await realpath(gitDirectory)) !== gitDirectory
  )
    throw new Error("Remote checkout changed");
  const marker = join(worktree, ".git");
  const identities = await Promise.all(
    [repository, worktree, repositoryCommon, marker, gitDirectory].map(async (path) => {
      const info = await lstat(path, { bigint: true });
      if (
        info.isSymbolicLink() ||
        (path === marker ? !info.isFile() && !info.isDirectory() : !info.isDirectory())
      )
        throw new Error("Invalid remote checkout");
      return [info.dev, info.ino, info.birthtimeNs].map(String);
    }),
  );
  return JSON.stringify([repositoryCommon, gitDirectory, identities]);
}
