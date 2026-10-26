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
$cli = Join-Path $env:FOOM_CLI_DIRECTORY 'foom.exe'
if (!(Test-Path -LiteralPath $cli -PathType Leaf)) { exit 0 }
# PowerShell's native invocation does not reliably forward pipe EOF. Relay bytes,
# without decoding MCP frames or keeping the caller alive after the CLI exits.
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Threading.Tasks;
public static class FoomPluginMcp {
  static async Task Input(Stream source, StreamWriter target) {
    try { await source.CopyToAsync(target.BaseStream).ConfigureAwait(false); }
    catch (IOException) { }
    catch (ObjectDisposedException) { }
    finally {
      try { target.Close(); }
      catch (IOException) { }
      catch (ObjectDisposedException) { }
    }
  }
  static async Task Output(Stream source, Stream target, Process child) {
    try { await source.CopyToAsync(target).ConfigureAwait(false); }
    catch (IOException) {
      try { child.Kill(); } catch (InvalidOperationException) { }
    }
  }
  public static int Run(string path) {
    // Process's stdin writer must never emit a BOM before the raw bytes.
    Console.InputEncoding = new System.Text.UTF8Encoding(false);
    var info = new ProcessStartInfo(path, "mcp") {
      UseShellExecute = false, CreateNoWindow = true,
      RedirectStandardInput = true, RedirectStandardOutput = true,
      RedirectStandardError = true
    };
    using (var child = new Process { StartInfo = info }) {
      if (!child.Start()) return 1;
      // Framework console streams can block before CopyToAsync returns its Task.
      // None of the pumps may block process-exit handling on this thread.
      var output = Task.Run(() => Output(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), child));
      var error = Task.Run(() => Output(child.StandardError.BaseStream, Console.OpenStandardError(), child));
      var input = Task.Run(() => Input(Console.OpenStandardInput(), child.StandardInput));
      child.WaitForExit();
      Task.WaitAll(output, error);
      GC.KeepAlive(input);
      return child.ExitCode;
    }
  }
}
'@
  exit ([FoomPluginMcp]::Run($cli))
} catch { exit 1 }
`,
  };
}
