import { spawn } from "node:child_process";
import { devNull } from "node:os";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentManifestV2 } from "../../shared/agent-manifest-v2";

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
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env:
        command === "git" ? { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull } : env,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
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
    const timer = setTimeout(() => {
      failure = new Error("Remote probe timed out");
      kill();
    }, 5000);
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.length;
      if (stdout > 256 * 1024) {
        failure = new Error("Remote probe output exceeded");
        kill();
      } else chunks.push(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.length;
      if (stderr > 256 * 1024) {
        failure = new Error("Remote probe output exceeded");
        kill();
      }
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("exit", kill);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error("Remote probe failed"));
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
export async function hostDiscovery(
  model: AgentManifestV2,
  shell: string,
  home: string,
): Promise<{ command: string; env: NodeJS.ProcessEnv; version: string; help: string }> {
  const env = hostEnvironment();
  let path = env["PATH"] ?? "";
  try {
    const output = await hostProbe(
      shell,
      ["-ilc", 'printf "\\000FOOM_PATH\\000%s\\000" "$PATH"'],
      home,
      env,
    );
    path = output.split("\0FOOM_PATH\0")[1]?.split("\0")[0] || path;
  } catch {
    /* Inherited remote PATH is the conservative discovery fallback. */
  }
  const launchEnv = { ...env, PATH: path };
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
  if (!command) throw new Error("Remote agent is unavailable");
  const fixed = async (args: string[]) => {
    try {
      return (await hostProbe(command, args, home, launchEnv)).trim();
    } catch {
      return "";
    }
  };
  const version = await fixed(["--version"]);
  const help = await fixed(["--help"]);
  return { command, env: launchEnv, version, help };
}
/** Canonical paths and live Git membership are rechecked immediately before PTY creation. */
export async function remoteCheckout(
  repository: string,
  worktree: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if ((await realpath(repository)) !== repository || (await realpath(worktree)) !== worktree)
    throw new Error("Remote checkout changed");
  const list = await hostProbe(
    "git",
    ["--no-optional-locks", "worktree", "list", "--porcelain", "-z"],
    repository,
    env,
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
        await hostProbe("git", ["--no-optional-locks", "rev-parse", "--git-common-dir"], cwd, env)
      ).trim(),
    );
  const repositoryCommon = await common(repository);
  if (repositoryCommon !== (await common(worktree))) throw new Error("Foreign remote worktree");
  const identities = await Promise.all(
    [repository, worktree, repositoryCommon].map(async (path) => {
      const info = await stat(path);
      if (!info.isDirectory()) throw new Error("Invalid remote checkout");
      return `${String(info.dev)}:${String(info.ino)}`;
    }),
  );
  return JSON.stringify([repositoryCommon, identities]);
}
