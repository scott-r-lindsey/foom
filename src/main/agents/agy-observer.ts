/** Static observer assets; no credentials or installation-specific paths in the plugin. */
export const AGY_PLUGIN_VERSION = 1;

export function agyPluginFiles(platform: NodeJS.Platform): Record<string, string> {
  const command =
    platform === "win32"
      ? "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./observer.ps1"
      : "sh ./observer.sh";
  const handler = (event: string) => ({
    type: "command",
    command: `${command} ${event}`,
    timeout: 3,
  });
  return {
    "plugin.json": JSON.stringify({
      name: "foom",
      version: "1.0.0",
      foomObserverVersion: AGY_PLUGIN_VERSION,
    }),
    "hooks.json": JSON.stringify({
      "foom-observer-v1": {
        PreInvocation: [handler("PreInvocation")],
        PostToolUse: [{ matcher: "*", hooks: [handler("PostToolUse")] }],
        Stop: [handler("Stop")],
      },
    }),
    "observer.sh": `#!/bin/sh
printf '{}\\n'
[ -n "$FOOM_HOOK_URL" ] && [ -n "$FOOM_SESSION" ] && [ -n "$FOOM_TOKEN" ] || exit 0
case "$1" in PreInvocation|PostToolUse|Stop) ;; *) exit 0 ;; esac
# Bound stdin before detaching. All worker descriptors are private, so the agent
# observes EOF immediately instead of waiting for curl's network timeout.
payload=$(head -c 65537) || exit 0
(printf '%s' "$payload" | curl -q --noproxy '*' --connect-timeout 1 --max-time 1 --silent --output /dev/null \\
  --request POST --header 'Content-Type: application/json' \\
  --header "Authorization: $FOOM_TOKEN" --header "X-Foom-Session: $FOOM_SESSION" \\
  --header "X-Foom-Event: $1" --data-binary @- "$FOOM_HOOK_URL") </dev/null >/dev/null 2>&1 &
exit 0
`,
    "observer.ps1": `# Return the neutral result before reading input or starting transport.
[Console]::Out.WriteLine('{}')
[Console]::Out.Flush()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (!$env:FOOM_HOOK_URL -or !$env:FOOM_SESSION -or !$env:FOOM_TOKEN) { exit 0 }
if ($args.Count -ne 1 -or $args[0] -notin @('PreInvocation','PostToolUse','Stop')) { exit 0 }
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  $buffer = New-Object char[] 65537
  $count = 0
  while ($count -lt $buffer.Length) {
    $read = [Console]::In.Read($buffer, $count, $buffer.Length - $count)
    if ($read -eq 0) { break }
    $count += $read
  }
  if ($count -gt 65536) { exit 0 }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = 'powershell.exe'
  $start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSScriptRoot + '\\send.ps1" ' + $args[0]
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardInputEncoding = New-Object System.Text.UTF8Encoding($false)
  $child = [System.Diagnostics.Process]::Start($start)
  try {
    $child.StandardInput.Write($buffer, 0, $count)
    $child.StandardInput.Close()
  } finally { $child.Dispose() }
} catch { }
exit 0
`,
    "send.ps1": `# Detached transport: no output, files, decisions, or global configuration.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  $payload = [Console]::In.ReadToEnd()
  $headers = @{ 'Authorization' = $env:FOOM_TOKEN; 'X-Foom-Session' = $env:FOOM_SESSION; 'X-Foom-Event' = $args[0] }
  Invoke-WebRequest -UseBasicParsing -Method Post -Uri $env:FOOM_HOOK_URL -Headers $headers -ContentType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 1 | Out-Null
} catch { }
exit 0
`,
  };
}
