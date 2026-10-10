import type { HookAgent } from "../../shared/hooks";

/** Write to a private launch directory; invoke with sh or PowerShell -File.
 * Agent output is stdin (Claude) or the final argument (Codex), never script code.
 * The launch service owns these files and supplies HookLaunch.env to the agent.
 */
export function hookAdapter(
  agent: HookAgent,
  platform: "posix" | "win32",
): {
  extension: ".sh" | ".ps1";
  source: string;
} {
  if (platform === "win32") {
    return {
      extension: ".ps1",
      source: `# Foom observer: never return an approval decision or agent output.
# Startup probe verifies interpreter and script policy without sending an event.
if ($args.Count -eq 1 -and $args[0] -eq '--foom-probe') { exit 0 }
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  $payload = ${agent === "claude" ? "[Console]::In.ReadToEnd()" : "$args[-1]"}
  $headers = @{ 'Authorization' = $env:FOOM_TOKEN; 'X-Foom-Session' = $env:FOOM_SESSION }
  # Loopback only: never use a system or environment proxy (5.1 lacks -NoProxy).
  $direct = @{}
  if ($PSVersionTable.PSVersion.Major -ge 6) { $direct['NoProxy'] = $true } else { [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy }
  Invoke-WebRequest @direct -UseBasicParsing -Method Post -Uri $env:FOOM_HOOK_URL -Headers $headers -ContentType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 3 | Out-Null
} catch { }
exit 0
`,
    };
  }
  return {
    extension: ".sh",
    source: `#!/bin/sh
# Disable curl config and proxies; never print payloads or response bodies.
{
${agent === "codex" ? "for payload do :; done\nprintf '%s' \"$payload\" | " : ""}curl -q --noproxy '*' --connect-timeout 1 --max-time 3 --silent --output /dev/null \\
  --request POST --header 'Content-Type: application/json' \\
  --header "Authorization: $FOOM_TOKEN" --header "X-Foom-Session: $FOOM_SESSION" \\
  --data-binary @- "$FOOM_HOOK_URL"
} >/dev/null 2>&1
exit 0
`,
  };
}
