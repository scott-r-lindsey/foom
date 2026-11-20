import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parse } from "smol-toml";
import { record } from "../../shared/remote-agent-protocol";
import type { CodexApprovals } from "../../shared/registered-hosts.d";

const maxConfigBytes = 64 * 1024;

/** Observe the account defaults without running Codex or returning its settings. */
export async function codexApprovals(
  home: string,
  env: NodeJS.ProcessEnv,
): Promise<CodexApprovals> {
  const directory = env["CODEX_HOME"] || join(home, ".codex");
  if (!isAbsolute(directory)) return "unknown";

  try {
    const file = await open(
      join(directory, "config.toml"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > maxConfigBytes)
        return "unknown";
      const bytes = Buffer.alloc(maxConfigBytes + 1);
      let used = 0;
      while (used < bytes.length) {
        const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > maxConfigBytes) return "unknown";
      const config = parse(
        new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, used)),
        {
          maxDepth: 24,
          unsafeKeyBehaviour: "throw",
        },
      );
      if (!record(config)) return "unknown";
      if (config["profile"] !== undefined || config["approvals_reviewer"] === "auto_review")
        return "unknown";
      const policy = config["approval_policy"];
      if (policy === "never") return "disabled";
      if (
        policy === undefined ||
        policy === "on-request" ||
        policy === "on-failure" ||
        policy === "untrusted" ||
        (record(policy) &&
          record(policy["granular"]) &&
          Object.values(policy["granular"]).some((value) => value === true))
      )
        return "may-prompt";
      return "unknown";
    } finally {
      await file.close();
    }
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? "may-prompt"
      : "unknown";
  }
}
