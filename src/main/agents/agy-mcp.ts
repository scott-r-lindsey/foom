/** Static plugin assets: all launch authority comes from the inherited environment. */
export function agyMcpFiles(windows: boolean, directory: string): Record<string, string> {
  const script = `${directory}/mcp.${windows ? "ps1" : "sh"}`;
  return {
    "mcp_config.json": JSON.stringify({
      mcpServers: {
        foom: {
          command: windows ? "powershell.exe" : "sh",
          args: windows
            ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]
            : [script],
        },
      },
    }),
    "mcp.sh": `#!/bin/sh
# No discovery, pairing, credentials on disk or PATH fallback.
[ -n "$FOOM_CONTROL_URL" ] && [ -n "$FOOM_SESSION" ] || exit 0
case "$FOOM_CONTROL_URL" in http://127.0.0.1:*/control/v1) ;; *) exit 0 ;; esac
port="\${FOOM_CONTROL_URL#http://127.0.0.1:}"
port="\${port%/control/v1}"
case "$port" in ''|*[!0-9]*|0*) exit 0 ;; esac
[ "$port" -le 65535 ] 2>/dev/null || exit 0
case "$FOOM_CONTROL_TOKEN" in ''|*[!a-f0-9]*) exit 0 ;; esac
[ "\${#FOOM_CONTROL_TOKEN}" -eq 64 ] || exit 0
case "$FOOM_SESSION" in *[!a-f0-9-]*) exit 0 ;; esac
case "$FOOM_SESSION" in ????????-????-????-????-????????????) ;; *) exit 0 ;; esac
case "$FOOM_CLI_DIRECTORY" in /*) ;; *) exit 0 ;; esac
[ -x "$FOOM_CLI_DIRECTORY/foom" ] || exit 0
exec "$FOOM_CLI_DIRECTORY/foom" mcp
`,
    "mcp.ps1": `$ErrorActionPreference = 'Stop'
if (!$env:FOOM_CONTROL_URL -or $env:FOOM_CONTROL_URL -cnotmatch '^http://127\\.0\\.0\\.1:[0-9]+/control/v1$' -or
    !$env:FOOM_CONTROL_TOKEN -or $env:FOOM_CONTROL_TOKEN -cnotmatch '^[a-f0-9]{64}$' -or
    !$env:FOOM_SESSION -or $env:FOOM_SESSION -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -or
    !$env:FOOM_CLI_DIRECTORY -or $env:FOOM_CLI_DIRECTORY -notmatch '^(?:[A-Za-z]:[\\\\/]|\\\\\\\\)') { exit 0 }
# Use framework APIs without autoloading ambient PowerShell modules.
$cli = [System.IO.Path]::Combine($env:FOOM_CLI_DIRECTORY, 'foom.exe')
if (![System.IO.File]::Exists($cli)) { exit 0 }
# Inherit the native stdio handles directly. PowerShell's pipeline must not read,
# encode or buffer MCP frames, or keep stdin open after the caller closes it.
try {
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $cli
  $start.Arguments = 'mcp'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $child = [System.Diagnostics.Process]::Start($start)
  if (!$child) { exit 1 }
  try {
    $child.WaitForExit()
    $code = $child.ExitCode
  } finally {
    $child.Dispose()
  }
  exit $code
} catch { exit 1 }
`,
  };
}
