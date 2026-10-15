/** Frozen pre-#435 definition serializer: independent compatibility oracle, never shipped. */
import { join } from "node:path";

export const CODEX_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
] as const;

/**
 * Bump a platform's observer version when its behavior changes: Codex hashes definitions,
 * not files. Windows v2 bypasses proxies explicitly.
 */
export const CODEX_OBSERVER_VERSIONS = { posix: 1, win32: 2 } as const;

export function codexObserverFile(platform: "posix" | "win32"): string {
  return `codex-v${String(CODEX_OBSERVER_VERSIONS[platform])}.${platform === "win32" ? "ps1" : "sh"}`;
}

export function codexObserverCommand(
  platform: NodeJS.Platform = process.platform,
  directory = join(__dirname, "../../src/observers"),
): string {
  const script = join(directory, codexObserverFile(platform === "win32" ? "win32" : "posix"));
  if (platform === "win32") {
    // An encoded, fixed invocation survives both cmd.exe and PowerShell parsing.
    const invocation = `& '${script.replaceAll("'", "''")}' codex`;
    return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(invocation, "utf16le").toString("base64")}`;
  }
  return `sh '${script.replaceAll("'", `'\\''`)}' codex`;
}

export function codexHookArguments(command: string): string[] {
  return CODEX_EVENTS.flatMap((event) => [
    "-c",
    `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=3}]}]`,
  ]);
}
