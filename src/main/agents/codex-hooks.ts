import { join, sep } from "node:path";

export const CODEX_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
] as const;

/** Bump the observer version when its behavior changes: Codex hashes definitions, not files. */
export function codexObserverCommand(
  platform: NodeJS.Platform = process.platform,
  directory = join(__dirname, "../../observers").replace(
    `app.asar${sep}`,
    `app.asar.unpacked${sep}`,
  ),
): string {
  const script = join(directory, `codex-v1.${platform === "win32" ? "ps1" : "sh"}`);
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

/** No output, no decisions, and no stdin read or network request without launch credentials. */
export function codexObserverSource(platform: "posix" | "win32"): string {
  if (platform === "win32")
    return `# Foom observe-only Codex hook v1.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (!$env:FOOM_HOOK_URL -or !$env:FOOM_SESSION -or !$env:FOOM_TOKEN) { exit 0 }
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  $payload = [Console]::In.ReadToEnd()
  $headers = @{ 'Authorization' = $env:FOOM_TOKEN; 'X-Foom-Session' = $env:FOOM_SESSION }
  Invoke-WebRequest -UseBasicParsing -Method Post -Uri $env:FOOM_HOOK_URL -Headers $headers -ContentType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 1 | Out-Null
} catch { }
exit 0
`;
  return `#!/bin/sh
# Foom observe-only Codex hook v1. Never return decisions or print agent data.
[ -n "$FOOM_HOOK_URL" ] && [ -n "$FOOM_SESSION" ] && [ -n "$FOOM_TOKEN" ] || exit 0
curl -q --noproxy '*' --connect-timeout 1 --max-time 1 --silent --output /dev/null \\
  --request POST --header 'Content-Type: application/json' \\
  --header "Authorization: $FOOM_TOKEN" --header "X-Foom-Session: $FOOM_SESSION" \\
  --data-binary @- "$FOOM_HOOK_URL" >/dev/null 2>&1
exit 0
`;
}
