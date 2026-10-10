/**
 * Static observer assets; no credentials or installation-specific paths in the plugin.
 * Version 2 bypasses proxies explicitly on Windows.
 */
export const AGY_PLUGIN_VERSION = 2;

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
# Sequence allocation is local and fast; only the network runs in the background.
# The launch owns this private file, which contains a number and no credentials.
[ -n "$FOOM_HOOK_ORDER" ] || exit 0
mkdir "$FOOM_HOOK_ORDER.lock" 2>/dev/null || exit 0
trap 'rmdir "$FOOM_HOOK_ORDER.lock" 2>/dev/null' 0
sequence=$(cat "$FOOM_HOOK_ORDER" 2>/dev/null) || exit 0
case "$sequence" in ''|*[!0-9]*|0?*) exit 0 ;; esac
[ "$sequence" -lt 2147483647 ] 2>/dev/null || exit 0
sequence=$((sequence + 1))
printf '%s' "$sequence" 2>/dev/null > "$FOOM_HOOK_ORDER" || exit 0
rmdir "$FOOM_HOOK_ORDER.lock" 2>/dev/null || exit 0
trap - 0
# Bound stdin before detaching. All worker descriptors are private, so the agent
# observes EOF immediately instead of waiting for curl's network timeout.
payload=$(head -c 65537) || exit 0
(printf '%s' "$payload" | curl -q --noproxy '*' --connect-timeout 1 --max-time 1 --silent --output /dev/null \\
  --request POST --header 'Content-Type: application/json' \\
  --header "Authorization: $FOOM_TOKEN" --header "X-Foom-Session: $FOOM_SESSION" \\
  --header "X-Foom-Event: $1" --header "X-Foom-Sequence: $sequence" --data-binary @- "$FOOM_HOOK_URL") </dev/null >/dev/null 2>&1 &
exit 0
`,
    "observer.ps1": `# Return the neutral result before reading input or starting transport.
[Console]::Out.WriteLine('{}')
[Console]::Out.Flush()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (!$env:FOOM_HOOK_URL -or !$env:FOOM_SESSION -or !$env:FOOM_TOKEN) { exit 0 }
if (!$env:FOOM_HOOK_ORDER) { exit 0 }
if ($args.Count -ne 1 -or $args[0] -notin @('PreInvocation','PostToolUse','Stop')) { exit 0 }
try {
  $order = [System.IO.File]::Open($env:FOOM_HOOK_ORDER, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  try {
    if ($order.Length -gt 10) { exit 0 }
    $bytes = New-Object byte[] 10
    $count = $order.Read($bytes, 0, 10)
    $value = [System.Text.Encoding]::ASCII.GetString($bytes, 0, $count)
    $sequence = 0
    if ($value -notmatch '^(0|[1-9][0-9]{0,9})$' -or ![int]::TryParse($value, [ref]$sequence) -or $sequence -eq 2147483647) { exit 0 }
    $sequence++
    $bytes = [System.Text.Encoding]::ASCII.GetBytes([string]$sequence)
    $order.SetLength(0)
    $order.Position = 0
    $order.Write($bytes, 0, $bytes.Length)
    $order.Flush()
  } finally { $order.Dispose() }
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  $buffer = New-Object char[] 65537
  $count = 0
  while ($count -lt $buffer.Length) {
    $read = [Console]::In.Read($buffer, $count, $buffer.Length - $count)
    if ($read -eq 0) { break }
    $count += $read
  }
  if ($count -gt 65536) { exit 0 }
  # .NET Framework Process.Start inherits unrelated PowerShell host handles.
  # Give the worker an explicit handle allowlist: its stdin and NUL only.
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class FoomObserverTransport {
  [StructLayout(LayoutKind.Sequential)]
  private struct Security { public int Size; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Startup {
    public int Size;
    public string Reserved, Desktop, Title;
    public int X, Y, Width, Height, XChars, YChars, Fill, Flags;
    public short Show, ReservedSize;
    public IntPtr ReservedData, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct Extended { public Startup Startup; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)]
  private struct Child { public IntPtr Process, Thread; public int ProcessId, ThreadId; }
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, int size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern IntPtr CreateFile(string name, uint access, int share, ref Security security, int creation, int flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")]
  private static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref Extended startup, out Child child);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool WriteFile(IntPtr file, byte[] bytes, int count, out int written, IntPtr overlapped);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  private static void Check(bool result) { if (!result) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  private static void Close(IntPtr handle) { if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); }
  public static void Send(string executable, string script, string eventName, int sequence, byte[] payload) {
    IntPtr input = IntPtr.Zero, writer = IntPtr.Zero, output = IntPtr.Zero;
    IntPtr list = IntPtr.Zero, handles = IntPtr.Zero;
    bool initialized = false;
    try {
      Security security = new Security { Size = Marshal.SizeOf(typeof(Security)), Inherit = 1 };
      Check(CreatePipe(out input, out writer, ref security, 0));
      output = CreateFile("NUL", 0x40000000, 3, ref security, 3, 0, IntPtr.Zero);
      Check(output != new IntPtr(-1));
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      list = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(list, 1, 0, ref size));
      initialized = true;
      handles = Marshal.AllocHGlobal(2 * IntPtr.Size);
      Marshal.WriteIntPtr(handles, 0, input);
      Marshal.WriteIntPtr(handles, IntPtr.Size, output);
      Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x20002), handles, new IntPtr(2 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      Extended startup = new Extended {
        Startup = new Startup { Size = Marshal.SizeOf(typeof(Extended)), Flags = 0x100, Input = input, Output = output, Error = output },
        Attributes = list
      };
      // Windows paths cannot contain quotes; eventName is a fixed enum and sequence an integer.
      StringBuilder command = new StringBuilder("\\"" + executable + "\\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \\"" + script + "\\" " + eventName + " " + sequence);
      Child child;
      Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, null, ref startup, out child));
      Close(child.Process);
      Close(child.Thread);
      int written;
      Check(WriteFile(writer, payload, payload.Length, out written, IntPtr.Zero));
      if (written != payload.Length) throw new InvalidOperationException("Incomplete observer input");
    } finally {
      Close(input); Close(writer); Close(output);
      if (initialized) DeleteProcThreadAttributeList(list);
      if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
      if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
    }
  }
}
'@
  $payload = [System.Text.Encoding]::UTF8.GetBytes($buffer, 0, $count)
  [FoomObserverTransport]::Send(($PSHOME + '\\powershell.exe'), ($PSScriptRoot + '\\send.ps1'), $args[0], $sequence, $payload)
} catch { }
exit 0
`,
    "send.ps1": `# Detached transport: no output, files, decisions, or global configuration.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  $payload = [Console]::In.ReadToEnd()
  $headers = @{ 'Authorization' = $env:FOOM_TOKEN; 'X-Foom-Session' = $env:FOOM_SESSION; 'X-Foom-Event' = $args[0]; 'X-Foom-Sequence' = $args[1] }
  # Loopback only: never use a system or environment proxy (5.1 lacks -NoProxy).
  $direct = @{}
  if ($PSVersionTable.PSVersion.Major -ge 6) { $direct['NoProxy'] = $true } else { [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy }
  Invoke-WebRequest @direct -UseBasicParsing -Method Post -Uri $env:FOOM_HOOK_URL -Headers $headers -ContentType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 1 | Out-Null
} catch { }
exit 0
`,
  };
}
