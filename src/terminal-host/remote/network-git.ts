import { hostProbe } from "./agent-discovery";
import { HostGitFailure } from "./git-failure";

/** Preserve host Git/SSH configuration; never use a hub command or credential. */
export async function networkGit(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
  signal?: AbortSignal,
): Promise<string> {
  try {
    let ssh = env["GIT_SSH_COMMAND"];
    if (!ssh) {
      ssh = (
        await hostProbe(
          "git",
          ["config", "--default", "ssh", "--get", "core.sshCommand"],
          cwd,
          env,
          true,
          5000,
          signal,
        )
      ).trim();
    }
    return await hostProbe(
      "git",
      ["--no-optional-locks", ...args],
      cwd,
      {
        ...env,
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        GIT_ASKPASS: "/usr/bin/false",
        SSH_ASKPASS: "/usr/bin/false",
        SSH_ASKPASS_REQUIRE: "never",
        GIT_SSH_COMMAND: `${ssh || "ssh"} -o BatchMode=yes`,
        GIT_SSH_VARIANT: "ssh",
      },
      true,
      timeout,
      signal,
      "probe",
      true,
    );
  } catch (error) {
    if (signal?.aborted) throw new HostGitFailure("cancelled");
    throw error instanceof HostGitFailure ? error : new HostGitFailure("origin-unreachable");
  }
}
